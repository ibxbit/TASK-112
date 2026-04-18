// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import NotificationCenter from "../src/pages/NotificationCenter";
import { db } from "../src/db/schema";
import { buildSession, cleanup, renderWithProviders, resetDatabase } from "./helpers/renderHarness";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(async () => {
  await resetDatabase();
});

const USER_ID = 1;

const seedUser = async (role: "administrator" | "dispatcher" | "operator" | "viewer" | "auditor" | "facilitator") => {
  await db.users.add({
    id: USER_ID,
    username: "alice",
    badgeId: "1234-5678",
    passwordHash: "x",
    salt: "y",
    iterations: 1,
    role,
    createdAt: new Date().toISOString(),
  } as unknown as Parameters<typeof db.users.add>[0]);
};

const seedNotification = async (overrides: Partial<{ id: number; level: "info" | "warn" | "error"; category: "task_assignment" | "equipment_alert" | "meeting_reminder" | "system"; message: string; eventType: string }> = {}) => {
  return db.notifications.add({
    userId: USER_ID,
    channel: "ui",
    category: overrides.category ?? "task_assignment",
    level: overrides.level ?? "info",
    eventType: overrides.eventType ?? "task.created",
    message: overrides.message ?? "Please acknowledge task #1",
    createdAt: new Date().toISOString(),
  });
};

describe("NotificationCenter", () => {
  it("loads the inbox, shows unread count and renders one row per notification", async () => {
    await seedUser("dispatcher");
    await seedNotification({ message: "alpha" });
    await seedNotification({ message: "bravo", level: "warn" });

    renderWithProviders(<NotificationCenter />, buildSession("dispatcher", { userId: USER_ID }));

    await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
    expect(screen.getByText("bravo")).toBeTruthy();
    expect(screen.getByText(/Unread: 2/)).toBeTruthy();
  });

  it("filters by level selector (observable DOM: only matching rows remain)", async () => {
    await seedUser("dispatcher");
    await seedNotification({ message: "info-one", level: "info" });
    await seedNotification({ message: "error-one", level: "error" });

    renderWithProviders(<NotificationCenter />, buildSession("dispatcher", { userId: USER_ID }));
    await waitFor(() => screen.getByText("info-one"));

    const [levelSelect] = Array.from(document.querySelectorAll("select")) as HTMLSelectElement[];
    act(() => {
      fireEvent.change(levelSelect, { target: { value: "error" } });
    });

    await waitFor(() => {
      expect(screen.queryByText("info-one")).toBeNull();
      expect(screen.getByText("error-one")).toBeTruthy();
    });
  });

  it("text search narrows to messages whose content matches the needle", async () => {
    await seedUser("dispatcher");
    await seedNotification({ message: "putaway please" });
    await seedNotification({ message: "picking now" });

    renderWithProviders(<NotificationCenter />, buildSession("dispatcher", { userId: USER_ID }));
    await waitFor(() => screen.getByText("putaway please"));

    const searchInput = screen.getByPlaceholderText("Search message/event") as HTMLInputElement;
    act(() => {
      fireEvent.change(searchInput, { target: { value: "picking" } });
    });
    await waitFor(() => {
      expect(screen.queryByText("putaway please")).toBeNull();
      expect(screen.getByText("picking now")).toBeTruthy();
    });
  });

  it("Mark Read drives dal.markNotificationRead and decrements the unread badge", async () => {
    await seedUser("dispatcher");
    const notifId = (await seedNotification({ message: "ack-me" })) as number;

    renderWithProviders(<NotificationCenter />, buildSession("dispatcher", { userId: USER_ID }));
    await waitFor(() => screen.getByText("ack-me"));
    expect(screen.getByText(/Unread: 1/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Mark Read" }));
    await waitFor(async () => {
      const receipts = await db.notification_read_receipts.where("notificationId").equals(notifId).toArray();
      expect(receipts.length).toBeGreaterThan(0);
    });
    await waitFor(() => expect(screen.getByText(/Unread: 0/)).toBeTruthy());
  });

  it("settings tab persists quiet hours through the real DAL (administrator has write on user_subscriptions)", async () => {
    await seedUser("administrator");
    renderWithProviders(<NotificationCenter />, buildSession("administrator", { userId: USER_ID }));
    await waitFor(() => screen.getByText(/Unread: 0/));

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    const timeInputs = Array.from(document.querySelectorAll('input[type="time"]')) as HTMLInputElement[];
    expect(timeInputs.length).toBe(2);
    act(() => {
      fireEvent.change(timeInputs[0], { target: { value: "21:00" } });
      fireEvent.change(timeInputs[1], { target: { value: "06:00" } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Quiet Hours" }));

    await waitFor(async () => {
      const subs = await db.user_subscriptions.toArray();
      const saved = subs.find((s) => s.userId === USER_ID);
      expect(saved?.quietHoursStart).toBe("21:00");
      expect(saved?.quietHoursEnd).toBe("06:00");
    });
  });

  it("hides Settings tab control entirely for Auditor (notifications:manage_settings is not granted)", async () => {
    await seedUser("auditor");
    renderWithProviders(<NotificationCenter />, buildSession("auditor", { userId: USER_ID }));
    await waitFor(() => screen.getByRole("button", { name: "Inbox" }));
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });
});
