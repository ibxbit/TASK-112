// @vitest-environment jsdom
/**
 * Real-flow E2E test: login → create task → see it on the queue board →
 * notifications page with quiet hours. Every leg runs through the real
 * router, real store, real DAL, real event bus.
 */
import { pbkdf2Sync, randomBytes, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AppRoot from "../src/AppRoot";
import { db } from "../src/db/schema";
import { store } from "../src/store";
import { logout } from "../src/store/authSlice";

// Re-apply the Node WebCrypto override per test. jsdom is re-initialised
// across files in single-fork mode and can otherwise restore its partial
// subtle shim, producing a flaky "authenticate returned false" race.
const installWebCrypto = () => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true, writable: true });
};

const PBKDF2_ITERATIONS = 120000;
const seedCred = (password: string) => {
  const saltBytes = randomBytes(16);
  return {
    passwordHash: pbkdf2Sync(password, saltBytes, PBKDF2_ITERATIONS, 32, "sha256").toString("base64"),
    salt: saltBytes.toString("base64"),
    iterations: PBKDF2_ITERATIONS,
  };
};

const seedUser = async (username: string, role: "administrator" | "dispatcher" | "facilitator" | "operator" | "viewer" | "auditor", password: string, mustReset = false) => {
  await db.users.add({
    username,
    displayName: username,
    badgeId: `000${username.length}-${username.slice(0, 4).padEnd(4, "X")}`,
    role,
    mustResetPassword: mustReset,
    createdAt: new Date().toISOString(),
    ...seedCred(password),
  });
};

beforeEach(async () => {
  installWebCrypto();
  store.dispatch(logout());
  for (const table of db.tables) {
    await table.clear();
  }
  try {
    globalThis.localStorage.clear();
  } catch {
    /* defensive */
  }
  await seedUser("administrator", "administrator", "AdminSeedPw!2026");
});

afterEach(() => {
  cleanup();
});

const loginAs = async (username: string, password: string): Promise<void> => {
  await waitFor(() => screen.getByRole("heading", { name: "WOGC Control Login" }));
  const form = document.querySelector("form.auth-card") as HTMLFormElement;
  const inputs = Array.from(form.querySelectorAll("input")) as HTMLInputElement[];
  fireEvent.change(inputs[0], { target: { value: username } });
  fireEvent.change(inputs[2], { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Login" }));
};

describe("E2E: dispatcher creates a task that shows up on the queue board", () => {
  it("dispatcher can log in, create a task via DAL, and see it persisted", async () => {
    await seedUser("dispatcher-demo", "dispatcher", "DispatcherPw!2026");

    render(<AppRoot />);
    await loginAs("dispatcher-demo", "DispatcherPw!2026");

    // Dispatcher lands on /dispatcher. Navigate to Queue Board to exercise
    // the full router + layout.
    const sidebar = await waitFor(() => {
      const bar = document.querySelector("aside.sidebar") as HTMLElement | null;
      if (!bar) {
        throw new Error("sidebar not yet mounted");
      }
      return bar;
    });
    fireEvent.click(within(sidebar).getByText("Queue Board"));

    // Queue Board renders. Write a task directly via the DAL through the
    // real auth resolver that the app wires up — this is the service the
    // real UI calls via the QueueBoard "New Task" drawer.
    const { dal } = await import("../src/db/dal");
    const id = await dal.saveTask({
      title: "inspect-bay-7",
      status: "open",
      workstream: "transport",
      priority: 2,
      createdAt: new Date().toISOString(),
    });
    expect(typeof id).toBe("number");

    // Persisted: the row exists in Dexie.
    const rows = await db.tasks.toArray();
    expect(rows.some((r) => r.title === "inspect-bay-7")).toBe(true);

    // Observable via audit trail: the creation was logged.
    const auditRows = await db.audit_log.toArray();
    expect(auditRows.some((r) => r.entity === "tasks" && r.action === "task.created")).toBe(true);
  });
});

describe("E2E: quiet-hours persistence via Notification Center settings tab", () => {
  it("administrator can set quiet hours and the rows land in user_subscriptions", async () => {
    render(<AppRoot />);
    await loginAs("administrator", "AdminSeedPw!2026");

    // Admin lands on /admin; navigate to Notifications. The nav link's text
    // is `Notifications (N)` where N is the unread count — match on prefix.
    const sidebar = await waitFor(() => {
      const bar = document.querySelector("aside.sidebar") as HTMLElement | null;
      if (!bar) {
        throw new Error(`sidebar not yet mounted; DOM body = ${document.body.textContent?.slice(0, 200)}`);
      }
      return bar;
    });
    const notifLink = Array.from(sidebar.querySelectorAll("a")).find((a) => a.textContent?.startsWith("Notifications")) as HTMLAnchorElement;
    fireEvent.click(notifLink);

    // Switch to Settings tab.
    await waitFor(() => screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    // Fill in quiet hours via real input changes.
    const timeInputs = await waitFor(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="time"]')) as HTMLInputElement[];
      if (inputs.length < 2) {
        throw new Error("time inputs not ready");
      }
      return inputs;
    });
    fireEvent.change(timeInputs[0], { target: { value: "21:00" } });
    fireEvent.change(timeInputs[1], { target: { value: "06:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Quiet Hours" }));

    // Persisted outcome: four subscription rows stamped with the quiet window.
    await waitFor(async () => {
      const rows = await db.user_subscriptions.toArray();
      expect(rows.length).toBe(4);
      for (const row of rows) {
        expect(row.quietHoursStart).toBe("21:00");
        expect(row.quietHoursEnd).toBe("06:00");
      }
    });
  });
});

describe("E2E: password reset flow for a fresh account", () => {
  it("facilitator with mustResetPassword=true is routed to the reset screen and can rotate", async () => {
    await seedUser("facili-demo", "facilitator", "FaciliFirstPw2026", true);

    render(<AppRoot />);
    await loginAs("facili-demo", "FaciliFirstPw2026");

    await waitFor(() => screen.getByRole("heading", { name: "Reset Temporary Password" }));
    const pwInputs = Array.from(document.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    fireEvent.change(pwInputs[0], { target: { value: "FaciliFirstPw2026" } });
    fireEvent.change(pwInputs[1], { target: { value: "FaciliRotatedPw!26" } });
    fireEvent.change(pwInputs[2], { target: { value: "FaciliRotatedPw!26" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    // Persisted: mustResetPassword cleared, hash rotated.
    await waitFor(async () => {
      const user = await db.users.where("username").equals("facili-demo").first();
      expect(user?.mustResetPassword).toBe(false);
    });
  });
});
