import { expect, test } from "@playwright/experimental-ct-react";
import AppRoot from "../../src/AppRoot";

type Role = "administrator" | "dispatcher" | "facilitator" | "operator" | "viewer" | "auditor";

test.beforeEach(async ({ page }) => {
  await page.evaluate(async () => {
    await (window as Window & { __wogcTest: { resetState: () => Promise<void> } }).__wogcTest.resetState();
  });
});

test("rapid user switch does not bleed scoped task data", async ({ mount, page }) => {
  await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: {
        seedScopedTask: (userId: number, title: string) => Promise<void>;
        loginAs: (role: Role, userId?: number) => Promise<void>;
        resetState: () => Promise<void>;
      };
    }).__wogcTest;
    await bridge.seedScopedTask(501, "A-private-task");
    await bridge.loginAs("operator", 501);
    await bridge.resetState();
    await bridge.seedScopedTask(502, "B-private-task");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    await bridge.loginAs("operator", 502);
  });

  const component = await mount(<AppRoot />);
  await expect(component.getByRole("heading", { name: "Queue Board" })).toBeVisible();
  await expect(component.getByRole("complementary").getByText(/B-privat/i)).toBeVisible();
  await expect(component.getByText("A-private-task")).toHaveCount(0);
});

test("idle auto-lock triggers despite background state updates", async ({ mount, page }) => {
  await page.clock.install();
  await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: {
        importRuntimeConfig: (partial: Record<string, unknown>) => Promise<void>;
        loginAs: (role: Role, userId?: number) => Promise<void>;
        triggerRoleRefresh: () => void;
        setSessionTimeout: (timeoutMs: number) => void;
      };
    }).__wogcTest;
    await bridge.importRuntimeConfig({ idleAutoLockMs: 250 });
    bridge.setSessionTimeout(250);
    await bridge.loginAs("viewer", 601);
    const timer = setInterval(() => bridge.triggerRoleRefresh(), 40);
    setTimeout(() => clearInterval(timer), 600);
  });

  const component = await mount(<AppRoot />);
  await page.evaluate(() => {
    window.localStorage.setItem("sessionTimeout", "250");
  });
  await page.clock.fastForward(2000);
  await page.evaluate(() => {
    const manager = (window as Window & { __WOGC_SESSION_MANAGER__?: { forceSetLastActivity: (ts: number) => void; tickHeartbeat: () => void } }).__WOGC_SESSION_MANAGER__;
    if (!manager) {
      throw new Error("Session manager bridge unavailable");
    }
    manager.forceSetLastActivity(Date.now() - 5000);
    manager.tickHeartbeat();
  });
  await expect(component.getByRole("heading", { name: "WOGC Control Login" })).toBeVisible();
});

test("operator workflow console output does not leak sensitive patterns", async ({ mount, page }) => {
  const logs: string[] = [];
  page.on("console", (msg) => {
    logs.push(msg.text());
  });

  await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: {
        loginAs: (role: Role, userId?: number) => Promise<void>;
        seedScopedTask: (userId: number, title: string) => Promise<void>;
      };
    }).__wogcTest;
    await bridge.seedScopedTask(701, "Operator Task");
    await bridge.loginAs("operator", 701);
  });

  const component = await mount(<AppRoot />);
  await expect(component.getByRole("heading", { name: "Queue Board" })).toBeVisible();

  const merged = logs.join("\n");
  expect(/\b\d{4}-\d{4}\b/.test(merged)).toBe(false);
  expect(/(?:password|token|secret|credential|apiKey)\s*[:=]\s*\S+/i.test(merged)).toBe(false);
});
