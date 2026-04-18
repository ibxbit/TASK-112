// @vitest-environment jsdom
/**
 * Real-flow E2E test: login -> dashboard navigation -> logout, plus
 * role-based sidebar restrictions across a full role transition.
 *
 * Everything below renders the whole <AppRoot /> inside jsdom so every
 * layer (router, store, thunks, DAL, Dexie, event bus) is real code.
 *
 * We pre-seed the admin credential row using Node's native `pbkdf2Sync`
 * to produce a hash the SPA's login thunk can verify. This is a
 * **fixture** (the equivalent of running the bootstrap endpoint in a
 * real deployment) — not a mock of the code under test. The login thunk,
 * the DAL, the session lifecycle, the router, and the sidebar RBAC all
 * run unmodified.
 */
import { pbkdf2Sync, randomBytes, webcrypto } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AppRoot from "../src/AppRoot";
import { db } from "../src/db/schema";
import { store } from "../src/store";
import { logout } from "../src/store/authSlice";

const installWebCrypto = () => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true, writable: true });
};

beforeAll(() => {
  installWebCrypto();
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:stub", configurable: true });
  }
  if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true });
  }
});

const PBKDF2_ITERATIONS = 120000;
const seedCredential = (password: string) => {
  const saltBytes = randomBytes(16);
  const hashBytes = pbkdf2Sync(password, saltBytes, PBKDF2_ITERATIONS, 32, "sha256");
  return {
    passwordHash: hashBytes.toString("base64"),
    salt: saltBytes.toString("base64"),
    iterations: PBKDF2_ITERATIONS,
  };
};

const seedUser = async (input: {
  username: string;
  displayName?: string;
  role: "administrator" | "dispatcher" | "facilitator" | "operator" | "viewer" | "auditor";
  password: string;
  mustResetPassword?: boolean;
}): Promise<number> => {
  const cred = seedCredential(input.password);
  const id = await db.users.add({
    username: input.username,
    displayName: input.displayName ?? input.username,
    badgeId: `0000-${input.username.slice(0, 4).padEnd(4, "X")}`,
    role: input.role,
    mustResetPassword: input.mustResetPassword ?? false,
    createdAt: new Date().toISOString(),
    ...cred,
  });
  return id as number;
};

beforeEach(async () => {
  installWebCrypto();
  // Reset the real app's singleton Redux store so tests don't inherit
  // authenticated state from a prior test in this file.
  store.dispatch(logout());
  for (const table of db.tables) {
    await table.clear();
  }
  try {
    globalThis.localStorage.clear();
  } catch {
    /* defensive */
  }
  // Every scenario starts with the administrator bootstrap already done;
  // the SPA will otherwise render the one-time initialise screen and the
  // test is no longer exercising the login flow.
  await seedUser({
    username: "administrator",
    role: "administrator",
    password: "AdminSeedPw!2026",
  });
});

afterEach(() => {
  cleanup();
});

const loginThroughUi = (username: string, password: string): void => {
  // The login form exposes three inputs in DOM order: Username, Display Name,
  // Password. Index lookup is the simplest stable accessor.
  const form = document.querySelector("form.auth-card") as HTMLFormElement;
  const inputs = Array.from(form.querySelectorAll("input")) as HTMLInputElement[];
  if (inputs.length < 3) {
    throw new Error(`login form has only ${inputs.length} inputs; dumping: ${form.innerHTML.slice(0, 400)}`);
  }
  fireEvent.change(inputs[0], { target: { value: username } });
  fireEvent.change(inputs[2], { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Login" }));
};

describe("E2E: login → sidebar navigation → logout", () => {
  it("administrator with no mustReset flag lands on /admin and sees the full sidebar", async () => {
    render(<AppRoot />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "WOGC Control Login" })).toBeTruthy());
    loginThroughUi("administrator", "AdminSeedPw!2026");

    await waitFor(() => expect(screen.getByRole("heading", { name: "Administrator Console" })).toBeTruthy());

    const sidebar = document.querySelector("aside.sidebar") as HTMLElement;
    const text = sidebar.textContent ?? "";
    for (const label of ["Dispatcher", "Queue Board", "Equipment", "Calendar", "Meetings", "Notifications", "Auditor Trail", "Admin Console"]) {
      expect(text).toContain(label);
    }
  });

  it("logout clears the session — a subsequent request returns to login and the store is reset", async () => {
    render(<AppRoot />);
    await waitFor(() => screen.getByRole("heading", { name: "WOGC Control Login" }));
    loginThroughUi("administrator", "AdminSeedPw!2026");
    await waitFor(() => screen.getByRole("heading", { name: "Administrator Console" }));

    const sidebar = document.querySelector("aside.sidebar") as HTMLElement;
    fireEvent.click(within(sidebar).getByRole("button", { name: "Logout" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "WOGC Control Login" })).toBeTruthy());
    // The session table should still have the row (it is append-only for
    // audit), but the in-memory Redux auth must be logged out: no sidebar.
    expect(document.querySelector("aside.sidebar")).toBeNull();
  });

  it("operator role: sidebar hides admin-only links and Auditor Trail", async () => {
    await seedUser({ username: "operator-demo", role: "operator", password: "OperatorLongPw2026" });

    render(<AppRoot />);
    await waitFor(() => screen.getByRole("heading", { name: "WOGC Control Login" }));
    loginThroughUi("operator-demo", "OperatorLongPw2026");

    // Operator home route is /queue (roleHomeRoute).
    await waitFor(() => {
      const bar = document.querySelector("aside.sidebar") as HTMLElement | null;
      expect(bar).toBeTruthy();
      expect(bar!.textContent ?? "").toContain("Queue Board");
    });

    const sidebar = document.querySelector("aside.sidebar") as HTMLElement;
    const text = sidebar.textContent ?? "";
    // Present for operator:
    expect(text).toContain("Queue Board");
    // Not present (RBAC filter in navItems):
    expect(text).not.toContain("Admin Console");
    expect(text).not.toContain("Auditor Trail");
    expect(text).not.toContain("Equipment");
  });
});

describe("E2E: password reset required on first login", () => {
  it("user flagged `mustResetPassword=true` is forced to /reset-password on login", async () => {
    await seedUser({
      username: "facilitator-demo",
      role: "facilitator",
      password: "FaciliFirstPw2026",
      mustResetPassword: true,
    });

    render(<AppRoot />);
    await waitFor(() => screen.getByRole("heading", { name: "WOGC Control Login" }));
    loginThroughUi("facilitator-demo", "FaciliFirstPw2026");

    // Observable outcome: the reset form is rendered, not the workspace.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Reset Temporary Password" })).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Meeting Workspace" })).toBeNull();
  });
});

describe("E2E: wrong credentials are rejected with an inline WOGCError code", () => {
  it("login with wrong password surfaces AUTH_LOGIN_FAIL inline and keeps the user on the login screen", async () => {
    await seedUser({ username: "alice", role: "dispatcher", password: "AliceRealPw2026" });

    render(<AppRoot />);
    await waitFor(() => screen.getByRole("heading", { name: "WOGC Control Login" }));
    loginThroughUi("alice", "AliceWrongPw");

    await waitFor(() => expect(screen.getByText(/AUTH_LOGIN_FAIL/)).toBeTruthy());
    expect(screen.getByRole("heading", { name: "WOGC Control Login" })).toBeTruthy();
  });
});
