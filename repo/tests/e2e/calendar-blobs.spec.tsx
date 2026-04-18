import { expect, test } from "@playwright/experimental-ct-react";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import AppRoot from "../../src/AppRoot";

type Role = "administrator" | "dispatcher" | "facilitator" | "operator" | "viewer" | "auditor";

test.beforeEach(async ({ page }) => {
  await page.evaluate(async () => {
    await (window as Window & { __wogcTest: { resetState: () => Promise<void> } }).__wogcTest.resetState();
  });
});

test("calendar capacity race reports conflict and keeps event stable", async ({ mount, page }) => {
  await page.evaluate(async () => {
    const bridge = (window as Window & { __wogcTest: { loginAs: (role: Role, userId?: number) => Promise<void> } }).__wogcTest;
    await bridge.loginAs("administrator", 801);
  });

  const component = await mount(<AppRoot />);
  await component.getByRole("button", { name: "Menu" }).click();
  await component.getByRole("link", { name: "Calendar" }).click();
  await expect(component.getByText("Operational Calendar")).toBeVisible();

  await component.getByPlaceholder("title").first().fill("Race Event");
  await component.getByRole("combobox").nth(1).selectOption({ label: "Meeting" });
  await component.getByRole("textbox", { name: "resource", exact: true }).fill("DOCK-1");
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const toLocal = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  await component.locator("input[type='datetime-local']").nth(0).fill(toLocal(start));
  await component.locator("input[type='datetime-local']").nth(1).fill(toLocal(end));
  await component.getByRole("button", { name: "Create Event" }).click();

  await component.getByPlaceholder("capacity resource").fill("DOCK-1");
  await component.locator("input[type='datetime-local']").nth(2).fill(toLocal(new Date(start.getTime() - 5 * 60 * 1000)));
  await component.locator("input[type='datetime-local']").nth(3).fill(toLocal(new Date(end.getTime() + 5 * 60 * 1000)));
  await component.locator("input[type='number']").first().fill("0");
  await component.getByRole("button", { name: "Save Capacity" }).click();

  await component.getByPlaceholder("title").first().fill("Race Event Duplicate");
  await component.getByRole("textbox", { name: "resource", exact: true }).fill("DOCK-1");
  await component.locator("input[type='datetime-local']").nth(0).fill(toLocal(start));
  await component.locator("input[type='datetime-local']").nth(1).fill(toLocal(end));
  await component.getByRole("button", { name: "Create Event" }).click();
  await expect(component.getByRole("dialog", { name: "Calendar conflict resolution" })).toBeVisible();
});

test("large blob upload >50MB is rejected safely", async ({ mount, page }) => {
  await page.evaluate(async () => {
    const bridge = (window as Window & { __wogcTest: { loginAs: (role: Role, userId?: number) => Promise<void> } }).__wogcTest;
    await bridge.loginAs("facilitator", 901);
  });

  const component = await mount(<AppRoot />);
  await page.evaluate(() => {
    window.history.pushState({}, "", "/meetings");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  await component.getByRole("textbox").nth(0).fill("Blob Test");
  await component.getByRole("textbox").nth(1).fill("facilitator");
  await component.getByRole("button", { name: "Save Meeting" }).click();

  const largeFilePath = path.join(os.tmpdir(), `wogc-large-${Date.now()}.pdf`);
  try {
    const fiftyPlus = 50 * 1024 * 1024 + 1;
    const payload = new Uint8Array(fiftyPlus).fill(1);
    await fs.writeFile(largeFilePath, payload);
    await component.locator("input[type='file']").setInputFiles(largeFilePath);
    await component.getByRole("button", { name: "Save Attachments" }).click();
    await expect(component.getByText(/ATTACHMENT_TOO_LARGE|exceeds 50MB/i)).toBeVisible();
  } finally {
    await fs.rm(largeFilePath, { force: true });
  }
});
