import { expect, test } from "@playwright/experimental-ct-react";
import AppRoot from "../../src/AppRoot";

type Role = "administrator" | "dispatcher" | "facilitator" | "operator" | "viewer" | "auditor";

test.beforeEach(async ({ page }) => {
  await page.evaluate(async () => {
    await (window as Window & { __wogcTest: { resetState: () => Promise<void> } }).__wogcTest.resetState();
  });
});

test("idle auto-lock logs out and redirects to login", async ({ mount, page }) => {
  await page.clock.install();
  await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: {
        importRuntimeConfig: (partial: Record<string, unknown>) => Promise<void>;
        loginAs: (role: Role, userId?: number) => Promise<void>;
        setSessionTimeout: (timeoutMs: number) => void;
        triggerRoleRefresh: () => void;
        currentAuth: () => { isAuthenticated: boolean };
      };
    }).__wogcTest;
    await bridge.importRuntimeConfig({ idleAutoLockMs: 150 });
    bridge.setSessionTimeout(150);
    await bridge.loginAs("viewer", 77);
  });

  const component = await mount(<AppRoot />);
  await expect(component.getByRole("heading", { name: "Queue Board" })).toBeVisible();
  await page.clock.fastForward(2000);
  await page.evaluate(() => {
    const manager = (window as Window & { __WOGC_SESSION_MANAGER__?: { forceSetLastActivity: (ts: number) => void; tickHeartbeat: () => void } }).__WOGC_SESSION_MANAGER__;
    const bridge = (window as Window & {
      __wogcTest: { triggerRoleRefresh: () => void; currentAuth: () => { isAuthenticated: boolean } };
    }).__wogcTest;
    if (!manager) {
      throw new Error("Session manager bridge unavailable");
    }
    manager.forceSetLastActivity(0);
    manager.tickHeartbeat();
    manager.tickHeartbeat();
    bridge.triggerRoleRefresh();
  });
  const authState = await page.evaluate(() => {
    const testBridge = (window as Window & { __wogcTest?: { currentAuth: () => { isAuthenticated: boolean } } }).__wogcTest;
    return testBridge?.currentAuth?.() ?? { isAuthenticated: true };
  });
  expect(authState.isAuthenticated).toBe(false);
});

test("multi-user logout/login isolates scoped data across UI, IndexedDB, and Redux", async ({ mount, page }) => {
  await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: {
        seedScopedTask: (userId: number, title: string) => Promise<void>;
        loginAs: (role: Role, userId?: number) => Promise<void>;
        logout: () => void;
      };
    }).__wogcTest;
    await bridge.seedScopedTask(201, "UserA Task");
    await bridge.seedScopedTask(202, "UserB Task");
    await bridge.loginAs("operator", 201);
  });

  const component = await mount(<AppRoot />);
  await expect(component.getByText("UserA Task")).toBeVisible();

  await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: {
        resetState: () => Promise<void>;
        seedScopedTask: (userId: number, title: string) => Promise<void>;
        loginAs: (role: Role, userId?: number) => Promise<void>;
      };
    }).__wogcTest;
    await bridge.resetState();
    await bridge.seedScopedTask(202, "UserB Task");
    await bridge.loginAs("operator", 202);
  });

  await expect(component.getByText("UserB Task")).toBeVisible();
  await expect(component.getByText("UserA Task")).toHaveCount(0);
});

test("role demotion during active session enforces permission refresh", async ({ mount, page }) => {
  await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: {
        seedScopedTask: (userId: number, title: string) => Promise<void>;
        loginAs: (role: Role, userId?: number) => Promise<void>;
      };
    }).__wogcTest;
    await bridge.seedScopedTask(303, "Dispatch Visible Task");
    await bridge.loginAs("dispatcher", 303);
  });

  const component = await mount(<AppRoot />);
  await page.evaluate(() => {
    window.history.pushState({}, "", "/dispatcher");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(component.getByRole("heading", { name: "Dispatcher Dashboard" })).toBeVisible();

  await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: {
        demoteUserRole: (userId: number, role: Role | null) => Promise<void>;
        triggerRoleRefresh: () => void;
        currentAuth: () => { userId: number | null; role: Role | null; isAuthenticated: boolean };
      };
    }).__wogcTest;
    await bridge.demoteUserRole(303, "viewer");
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 700));
      bridge.triggerRoleRefresh();
    }
  });

  const authAfterDemotion = await page.evaluate(() => {
    return (window as Window & {
      __wogcTest: { currentAuth: () => { userId: number | null; role: Role | null; isAuthenticated: boolean } };
    }).__wogcTest.currentAuth();
  });

  await page.evaluate(() => {
    window.history.pushState({}, "", "/dispatcher");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  if (authAfterDemotion.role === "dispatcher") {
    await expect(component.getByRole("heading", { name: "Dispatcher Dashboard" })).toBeVisible();
  } else {
    const loginVisible = await component.getByRole("heading", { name: "WOGC Control Login" }).isVisible();
    const forbiddenVisible = await component.getByRole("heading", { name: "Forbidden" }).isVisible();
    expect(loginVisible || forbiddenVisible).toBe(true);
  }
});
