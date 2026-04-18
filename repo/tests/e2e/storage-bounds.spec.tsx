import { expect, test } from "@playwright/experimental-ct-react";
import AppRoot from "../../src/AppRoot";

type Role = "administrator" | "dispatcher" | "facilitator" | "operator" | "viewer" | "auditor";

test.beforeEach(async ({ page }) => {
  await page.evaluate(async () => {
    await (window as Window & { __wogcTest: { resetState: () => Promise<void> } }).__wogcTest.resetState();
  });
});

test("strict storage bounds across rapid login/logout cycles", async ({ mount, page }) => {
  const component = await mount(<AppRoot />);

  await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: {
        loginAs: (role: Role, userId?: number) => Promise<void>;
      };
    }).__wogcTest;
    await bridge.loginAs("operator", 401);
  });
  await expect(component.getByRole("heading", { name: "Queue Board" })).toBeVisible();

  await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: {
        resetState: () => Promise<void>;
        loginAs: (role: Role, userId?: number) => Promise<void>;
      };
    }).__wogcTest;
    await bridge.resetState();
    await bridge.loginAs("operator", 402);
  });
  await expect(component.getByRole("heading", { name: "Queue Board" })).toBeVisible();

  await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: {
        resetState: () => Promise<void>;
        loginAs: (role: Role, userId?: number) => Promise<void>;
      };
    }).__wogcTest;
    await bridge.resetState();
    await bridge.loginAs("operator", 403);
  });
  await expect(component.getByRole("heading", { name: "Queue Board" })).toBeVisible();

  const keys = await page.evaluate(() => Object.keys(window.localStorage).sort());
  expect(keys.every((key) => key === "theme" || key === "last_site")).toBe(true);

  await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: {
        resetState: () => Promise<void>;
        loginAs: (role: Role, userId?: number) => Promise<void>;
        emitAuditProbe: () => Promise<void>;
      };
    }).__wogcTest;
    await bridge.resetState();
    await bridge.loginAs("administrator", 1);
    await bridge.emitAuditProbe();
  });
  await expect(component.getByRole("button", { name: "Menu" })).toBeVisible();
  await component.getByRole("button", { name: "Menu" }).click();
  await component.getByRole("link", { name: "Notifications" }).click();
  await expect(component.getByRole("heading", { name: "Notification Center" })).toBeVisible();

  const auditState = await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: {
        loginAs: (role: Role, userId?: number) => Promise<void>;
        auditSequenceHealth: () => Promise<{ hasRegression: boolean; count: number }>;
      };
    }).__wogcTest;
    await bridge.loginAs("administrator", 1);
    return bridge.auditSequenceHealth();
  });
  expect(auditState.hasRegression).toBe(false);
  expect(auditState.count).toBeGreaterThan(0);
});
