import { expect, test } from "@playwright/experimental-ct-react";
import AppRoot from "../../src/AppRoot";

type Role = "administrator" | "dispatcher" | "facilitator" | "operator" | "viewer" | "auditor";

test.beforeEach(async ({ page }) => {
  await page.evaluate(async () => {
    await (window as Window & { __wogcTest: { resetState: () => Promise<void> } }).__wogcTest.resetState();
  });
});

test("RoleGate blocks direct admin navigation for viewer", async ({ mount, page }) => {
  await page.evaluate(async () => {
    await (window as Window & { __wogcTest: { loginAs: (role: Role, userId?: number) => Promise<void> } }).__wogcTest.loginAs("viewer", 321);
  });
  const component = await mount(<AppRoot />);
  await page.evaluate(() => {
    window.history.pushState({}, "", "/admin");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(component.getByRole("heading", { name: "Forbidden" })).toBeVisible();
});

test("Can-gated admin backup controls hidden for facilitator", async ({ mount, page }) => {
  await page.evaluate(async () => {
    await (window as Window & { __wogcTest: { loginAs: (role: Role, userId?: number) => Promise<void> } }).__wogcTest.loginAs("facilitator", 88);
  });
  const component = await mount(<AppRoot />);
  await page.evaluate(() => {
    window.history.pushState({}, "", "/meetings");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(component.getByRole("heading", { name: "Meeting Workspace" })).toBeVisible();
  await expect(component.getByRole("heading", { name: "Encrypted Backup Export" })).toHaveCount(0);
});

test("Conflict resolver requires reason before mutation", async ({ mount, page }) => {
  await page.evaluate(async () => {
    const bridge = (window as Window & { __wogcTest: { seedConflictTasks: () => Promise<void>; loginAs: (role: Role, userId?: number) => Promise<void> } }).__wogcTest;
    await bridge.seedConflictTasks();
    await bridge.loginAs("dispatcher", 1);
  });
  const component = await mount(<AppRoot />);
  await page.evaluate(() => {
    window.history.pushState({}, "", "/queue");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await component.getByRole("button", { name: /Resolve Conflicts/i }).click();
  await component.getByRole("dialog", { name: "Resolve Queue Conflict" }).getByRole("button", { name: "Resolve" }).click();
  await expect(component.getByText("Please provide a concrete resolution reason", { exact: false })).toBeVisible();
});

test("Notification read action updates unread indicator", async ({ mount, page }) => {
  await page.evaluate(async () => {
    const bridge = (window as Window & { __wogcTest: { seedNotification: (userId: number) => Promise<void>; loginAs: (role: Role, userId?: number) => Promise<void> } }).__wogcTest;
    await bridge.seedNotification(22);
    await bridge.loginAs("dispatcher", 22);
  });
  const component = await mount(<AppRoot />);
  await page.evaluate(() => {
    window.history.pushState({}, "", "/notifications");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(component.getByRole("heading", { name: "Notification Center" })).toBeVisible();
  await component.getByRole("button", { name: "Mark Read" }).first().click();
  await expect(component.getByText("Unread: 0")).toBeVisible();
});
