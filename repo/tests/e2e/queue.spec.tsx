import { expect, test } from "@playwright/experimental-ct-react";
import AppRoot from "../../src/AppRoot";

type Role = "administrator" | "dispatcher" | "facilitator" | "operator" | "viewer" | "auditor";

test.beforeEach(async ({ page }) => {
  await page.evaluate(async () => {
    await (window as Window & { __wogcTest: { resetState: () => Promise<void> } }).__wogcTest.resetState();
  });
});

test("dispatcher queue flow resolves conflict through modal", async ({ mount, page }) => {
  await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: { seedConflictTasks: () => Promise<void>; loginAs: (role: Role, userId?: number) => Promise<void> };
    }).__wogcTest;
    await bridge.seedConflictTasks();
    await bridge.loginAs("dispatcher", 1);
  });

  const component = await mount(<AppRoot />);
  await component.getByRole("button", { name: "Menu" }).click();
  await component.getByRole("link", { name: "Queue Board" }).click();
  await expect(component.getByRole("heading", { name: "Queue Board" })).toBeVisible();
  await component.getByRole("button", { name: /Resolve Conflicts/i }).click();
  await expect(component.getByRole("dialog", { name: "Resolve Queue Conflict" })).toBeVisible();
  await component.getByLabel("Resolution Reason").fill("Dispatch triage ownership confirmed for inbound bin lane.");
  await component.getByRole("dialog", { name: "Resolve Queue Conflict" }).getByRole("button", { name: "Resolve" }).click();
  await expect(component.getByRole("dialog", { name: "Resolve Queue Conflict" })).toHaveCount(0);
});
