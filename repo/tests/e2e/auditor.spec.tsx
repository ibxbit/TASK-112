import { expect, test } from "@playwright/experimental-ct-react";
import AppRoot from "../../src/AppRoot";

type Role = "administrator" | "dispatcher" | "facilitator" | "operator" | "viewer" | "auditor";

test.beforeEach(async ({ page }) => {
  await page.evaluate(async () => {
    await (window as Window & { __wogcTest: { resetState: () => Promise<void> } }).__wogcTest.resetState();
  });
});

test("auditor cannot mutate DLQ and sees masked badge ids", async ({ mount, page }) => {
  await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: {
        seedConflictTasks: () => Promise<void>;
        loginAs: (role: Role, userId?: number) => Promise<void>;
        emitAuditProbe: () => Promise<void>;
      };
    }).__wogcTest;
    await bridge.seedConflictTasks();
    await bridge.loginAs("administrator", 1);
    await bridge.emitAuditProbe();
    await bridge.loginAs("auditor", 7);
  });

  const component = await mount(<AppRoot />);
  await page.evaluate(() => {
    window.history.pushState({}, "", "/auditor");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(component.getByRole("heading", { name: "Auditor Trail Viewer" })).toBeVisible();
  await expect(component.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(component.getByText(/\[-\] \(administrator\)/)).toHaveCount(1);
  await expect(component.getByText("ADMN-0001")).toHaveCount(0);
});

test("logout isolates session state and returns to login", async ({ mount, page }) => {
  await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: { seedScopedTask: (userId: number, title: string) => Promise<void>; loginAs: (role: Role, userId?: number) => Promise<void> };
    }).__wogcTest;
    await bridge.seedScopedTask(401, "A-private-task");
    await bridge.loginAs("dispatcher", 401);
  });

  const component = await mount(<AppRoot />);
  await component.getByRole("button", { name: "Menu" }).click();
  await component.getByRole("link", { name: "Queue Board" }).click();
  await expect(component.getByRole("heading", { name: "Queue Board" })).toBeVisible();
  await component.getByRole("button", { name: "Logout" }).click();
  await expect(component.getByRole("heading", { name: "WOGC Control Login" })).toBeVisible();
});
