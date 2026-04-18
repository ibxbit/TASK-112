// @vitest-environment jsdom
/**
 * Behavior matrix for <NotificationSettings>.
 *
 * Real DAL, real Redux store. No spies.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import NotificationSettings from "../src/pages/NotificationSettings";
import { db } from "../src/db/schema";
import { buildSession, cleanup, renderWithProviders, resetDatabase } from "./helpers/renderHarness";

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  cleanup();
});

describe("NotificationSettings page", () => {
  it("shows the four categories enabled by default when no subscription rows exist", async () => {
    renderWithProviders(<NotificationSettings />, buildSession("administrator"));
    await waitFor(() => expect(screen.getByText("task_assignment")).toBeTruthy());

    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(checkboxes).toHaveLength(4);
    for (const box of checkboxes) {
      expect(box.checked).toBe(true);
    }
  });

  it("toggling a category persists a subscription row via the real DAL", async () => {
    const { store } = renderWithProviders(<NotificationSettings />, buildSession("administrator"));
    await waitFor(() => expect(screen.getByText("task_assignment")).toBeTruthy());

    const firstCheckbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      fireEvent.click(firstCheckbox);
    });

    await waitFor(async () => {
      const rows = await db.user_subscriptions.toArray();
      const taskAssignmentRow = rows.find((r) => r.category === "task_assignment");
      expect(taskAssignmentRow?.enabled).toBe(false);
    });
    const success = store.getState().ui.toasts.find((t: { variant: string }) => t.variant === "success");
    expect(success?.message ?? "").toMatch(/Notification preference updated/);
  });

  it("saving quiet hours writes values into every category subscription row", async () => {
    renderWithProviders(<NotificationSettings />, buildSession("administrator"));
    await waitFor(() => expect(screen.getByText("task_assignment")).toBeTruthy());

    const timeInputs = Array.from(document.querySelectorAll('input[type="time"]')) as HTMLInputElement[];
    expect(timeInputs).toHaveLength(2);
    act(() => {
      fireEvent.change(timeInputs[0], { target: { value: "21:30" } });
      fireEvent.change(timeInputs[1], { target: { value: "05:45" } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Quiet Hours" }));

    await waitFor(async () => {
      const rows = await db.user_subscriptions.toArray();
      expect(rows.length).toBe(4); // one row per category
      for (const row of rows) {
        expect(row.quietHoursStart).toBe("21:30");
        expect(row.quietHoursEnd).toBe("05:45");
      }
    });
  });

  it("reloads current preferences from persisted rows on mount", async () => {
    // Seed: first category disabled, others default enabled.
    await db.user_subscriptions.add({
      userId: 1,
      category: "meeting_reminder",
      enabled: false,
      quietHoursStart: "22:00",
      quietHoursEnd: "06:00",
      updatedAt: new Date().toISOString(),
    });

    renderWithProviders(<NotificationSettings />, buildSession("administrator"));

    await waitFor(() => expect(screen.getByText("meeting_reminder")).toBeTruthy());
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    const byLabel = new Map<string, HTMLInputElement>();
    for (const box of checkboxes) {
      const label = box.closest("label");
      byLabel.set(label?.textContent?.split(/\s/).find((s) => s.length > 0) ?? "", box);
    }
    // Find the meeting_reminder checkbox by matching its preceding label text.
    const labels = Array.from(document.querySelectorAll("label span"));
    const targetLabel = labels.find((el) => el.textContent === "meeting_reminder");
    const targetCheckbox = targetLabel?.parentElement?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(targetCheckbox?.checked).toBe(false);

    // Quiet hours values are hydrated too.
    const timeInputs = Array.from(document.querySelectorAll('input[type="time"]')) as HTMLInputElement[];
    expect(timeInputs[0].value).toBe("22:00");
    expect(timeInputs[1].value).toBe("06:00");
  });

  it("noops when no user is authenticated (no DAL reads, no UI error)", async () => {
    renderWithProviders(<NotificationSettings />, { isAuthenticated: false, userId: null, username: null, role: null });
    // Page still renders (no crash), but no checkboxes populated.
    await waitFor(() => expect(screen.getByText("Notification Settings")).toBeTruthy());
    const rows = await db.user_subscriptions.toArray();
    expect(rows).toHaveLength(0);
  });
});
