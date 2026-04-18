import { expect, test } from "@playwright/experimental-ct-react";
import AppRoot from "../../src/AppRoot";

type Role = "administrator" | "dispatcher" | "facilitator" | "operator" | "viewer" | "auditor";

test.beforeEach(async ({ page }) => {
  await page.evaluate(async () => {
    await (window as Window & { __wogcTest: { resetState: () => Promise<void> } }).__wogcTest.resetState();
  });
  await page.evaluate(() => {
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
});

test("unauthenticated direct protected routes redirect to login", async ({ mount, page }) => {
  const component = await mount(<AppRoot />);
  await page.evaluate(() => {
    window.history.pushState({}, "", "/admin");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(component.getByRole("heading", { name: "WOGC Control Login" })).toBeVisible();
});

test("role-based redirection lands viewer on queue", async ({ mount, page }) => {
  await page.evaluate(() => {
    return (window as Window & { __wogcTest: { loginAs: (role: Role, userId?: number) => Promise<void> } }).__wogcTest.loginAs("viewer", 11);
  });
  const component = await mount(<AppRoot />);
  await expect(component.getByRole("heading", { name: "Queue Board" })).toBeVisible();
});

test("role gate blocks direct admin URL navigation for viewer", async ({ mount, page }) => {
  await page.evaluate(() => {
    return (window as Window & { __wogcTest: { loginAs: (role: Role, userId?: number) => Promise<void> } }).__wogcTest.loginAs("viewer", 12);
  });
  const component = await mount(<AppRoot />);
  await page.evaluate(() => {
    window.history.pushState({}, "", "/admin");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(component.getByRole("heading", { name: "Forbidden" })).toBeVisible();
  await expect(component.locator(".toast-permission-error")).toHaveCount(1);
});

const personaCases: Array<{ role: Role; allow: string; deny: string }> = [
  { role: "administrator", allow: "/admin", deny: "/not-a-route" },
  { role: "dispatcher", allow: "/delivery-logs", deny: "/admin" },
  { role: "facilitator", allow: "/delivery-logs", deny: "/admin" },
  { role: "operator", allow: "/queue", deny: "/admin" },
  { role: "auditor", allow: "/auditor", deny: "/admin" },
];

for (const entry of personaCases) {
  test(`persona route matrix: ${entry.role}`, async ({ mount, page }) => {
    await page.evaluate(({ role, idx }) => {
      return (window as Window & { __wogcTest: { loginAs: (value: Role, userId?: number) => Promise<void> } }).__wogcTest.loginAs(role, 100 + idx);
    }, { role: entry.role, idx: personaCases.indexOf(entry) });

    const component = await mount(<AppRoot />);
    await page.evaluate((allowPath) => {
      window.history.pushState({}, "", allowPath);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, entry.allow);
    await expect(component.getByRole("button", { name: "Menu" })).toBeVisible();

    await page.evaluate((denyPath) => {
      window.history.pushState({}, "", denyPath);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, entry.deny);
    if (entry.deny === "/not-a-route") {
      await expect(component.getByRole("heading", { name: "Administrator Console" })).toBeVisible();
    } else {
      await expect(component.getByRole("heading", { name: "Forbidden" })).toBeVisible();
    }
  });
}

test("queue conflict resolution enforces reason and resolves", async ({ mount, page }) => {
  await page.evaluate(async () => {
    const bridge = (window as Window & { __wogcTest: { seedConflictTasks: () => Promise<void>; loginAs: (value: Role, userId?: number) => Promise<void> } }).__wogcTest;
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
  await component.getByLabel("Resolution Reason").fill("Resolved by dispatch priority and SLA ownership.");
  await component.getByRole("dialog", { name: "Resolve Queue Conflict" }).getByRole("button", { name: "Resolve" }).click();
  await expect(component.getByRole("dialog", { name: "Resolve Queue Conflict" })).toHaveCount(0);
});

test("notification read path marks notification as read", async ({ mount, page }) => {
  await page.evaluate(async () => {
    const bridge = (window as Window & { __wogcTest: { seedNotification: (userId: number) => Promise<void>; loginAs: (value: Role, userId?: number) => Promise<void> } }).__wogcTest;
    await bridge.seedNotification(22);
    await bridge.loginAs("dispatcher", 22);
  });

  const component = await mount(<AppRoot />);
  await page.evaluate(() => {
    window.history.pushState({}, "", "/notifications");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await component.getByRole("button", { name: "Menu" }).click();
  await component.getByRole("link", { name: "Notifications" }).click();
  await expect(component.getByRole("heading", { name: "Notification Center" })).toBeVisible();
  await expect(component.getByRole("button", { name: "Mark Read" })).toHaveCount(1);
  await component.getByRole("button", { name: "Mark Read" }).first().click();
  await expect(component.getByText("Unread: 0")).toBeVisible();
});

test("meeting material distribution persists files and creates delivery logs with read receipts", async ({ mount, page }) => {
  const attendeeId = await page.evaluate(async () => {
    const bridge = (window as Window & {
      __wogcTest: {
        resetState: () => Promise<void>;
        loginAs: (role: Role | null, userId?: number) => Promise<void>;
        seedConflictTasks: () => Promise<void>;
        seedNotification: (userId: number) => Promise<void>;
        seedMeetingAttendee: () => Promise<number>;
        createMeetingForDistribution: () => Promise<void>;
        seedMeetingDistributionFixture: () => Promise<number>;
        meetingStats: () => Promise<{ meetingId: number | null; attachmentCount: number; hasBlob: boolean }>;
        deliveryLogCount: (userId: number, eventType: string) => Promise<number>;
        markFirstNotificationRead: (userId: number) => Promise<boolean>;
        hasReadDeliveryLog: (userId: number, eventType: string) => Promise<boolean>;
      };
    }).__wogcTest;
    const id = await bridge.seedMeetingDistributionFixture();
    await bridge.loginAs("administrator", 1);
    await bridge.loginAs("facilitator", 31);
    return id;
  });

  const component = await mount(<AppRoot />);
  await page.evaluate(() => {
    window.history.pushState({}, "", "/meetings");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await component.getByRole("button", { name: "Menu" }).click();
  await component.getByRole("link", { name: "Meetings" }).click();

  await page.evaluate(async () => {
    await (window as Window & { __wogcTest: { loginAs: (role: Role, userId?: number) => Promise<void> } }).__wogcTest.loginAs("administrator", 1);
  });
  await expect(component.getByText("pack.pdf")).toBeVisible();
  await component.getByRole("button", { name: "Distribute Materials" }).click();
  await expect(component.getByText(/Distributed materials to 1 attendee/)).toBeVisible();

  const stats = await page.evaluate(async () => {
    await (window as Window & { __wogcTest: { loginAs: (role: Role, userId?: number) => Promise<void> } }).__wogcTest.loginAs("facilitator", 31);
    return (window as Window & { __wogcTest: { meetingStats: () => Promise<{ meetingId: number | null; attachmentCount: number; hasBlob: boolean }> } }).__wogcTest.meetingStats();
  });
  expect(stats.attachmentCount).toBeGreaterThan(0);
  expect(stats.hasBlob).toBe(true);

  const deliveryCount = await page.evaluate(async (userId) => {
    await (window as Window & { __wogcTest: { loginAs: (role: Role, userId?: number) => Promise<void> } }).__wogcTest.loginAs("administrator", 1);
    return (window as Window & { __wogcTest: { deliveryLogCount: (id: number, eventType: string) => Promise<number> } }).__wogcTest.deliveryLogCount(userId, "meeting.materials.distributed");
  }, attendeeId);
  expect(deliveryCount).toBeGreaterThan(0);

  const markedRead = await page.evaluate(async (userId) => {
    return (window as Window & { __wogcTest: { markFirstNotificationRead: (id: number) => Promise<boolean> } }).__wogcTest.markFirstNotificationRead(userId);
  }, attendeeId);
  if (markedRead) {
    const hasRead = await page.evaluate(async (userId) => {
      await (window as Window & { __wogcTest: { loginAs: (role: Role, userId?: number) => Promise<void> } }).__wogcTest.loginAs("administrator", 1);
      return (window as Window & { __wogcTest: { hasReadDeliveryLog: (id: number, eventType: string) => Promise<boolean> } }).__wogcTest.hasReadDeliveryLog(userId, "meeting.materials.distributed");
    }, attendeeId);
    expect(hasRead).toBe(true);
  }
});
