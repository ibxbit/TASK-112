import { expect, test } from "@playwright/experimental-ct-react";
import AppRoot from "../../src/AppRoot";

const resetRuntimeState = async (page: { evaluate: (fn: () => Promise<void>) => Promise<void> }): Promise<void> => {
  await page.evaluate(async () => {
    window.localStorage.clear();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("wogc_db");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error("Failed to delete IndexedDB"));
      request.onblocked = () => resolve();
    });
  });
};

test.beforeEach(async ({ page }) => {
  await resetRuntimeState(page);
});

test("first run requires administrator bootstrap and rejects known default credentials", async ({ mount }) => {
  const component = await mount(<AppRoot />);

  await expect(component.getByRole("heading", { name: "Initialize Administrator" })).toBeVisible();
  await expect(component.getByRole("heading", { name: "WOGC Control Login" })).toHaveCount(0);

  await component.getByLabel(/^Administrator Password$/).fill("Admin@12345");
  await component.getByLabel(/^Confirm Administrator Password$/).fill("Admin@12345");
  await component.getByRole("button", { name: "Initialize Admin" }).click();
  await expect(component.getByText("at least 12 characters", { exact: false })).toBeVisible();

  await component.getByLabel(/^Administrator Password$/).fill("SecureAdminPass123");
  await component.getByLabel(/^Confirm Administrator Password$/).fill("SecureAdminPass123");
  await component.getByRole("button", { name: "Initialize Admin" }).click();

  await expect(component.getByRole("heading", { name: "WOGC Control Login" })).toBeVisible();

  await component.getByLabel("Username").fill("auditor");
  await component.getByLabel("Password / Temporary Password").fill("Audit@12345");
  await component.getByRole("button", { name: "Login" }).click();
  await expect(component.getByText("AUTH_LOGIN_FAIL", { exact: false })).toBeVisible();

  await component.getByLabel("Username").fill("administrator");
  await component.getByLabel("Password / Temporary Password").fill("Admin@12345");
  await component.getByRole("button", { name: "Login" }).click();
  await expect(component.getByText("AUTH_LOGIN_FAIL", { exact: false })).toBeVisible();

  await component.getByLabel("Username").fill("administrator");
  await component.getByLabel("Password / Temporary Password").fill("SecureAdminPass123");
  await component.getByRole("button", { name: "Login" }).click();
  await expect(component.getByRole("heading", { name: "Reset Temporary Password" })).toBeVisible();
});
