// @vitest-environment jsdom
/**
 * Behavior matrix for <DeliveryLogViewer>.
 *
 * Drives the real DAL over fake-indexeddb. No mocks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import DeliveryLogViewer from "../src/pages/DeliveryLogViewer";
import { db } from "../src/db/schema";
import { buildSession, cleanup, renderWithProviders, resetDatabase } from "./helpers/renderHarness";

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  cleanup();
});

const seedLog = async (input: {
  userId: number;
  eventType: string;
  deliveredAt: string;
  status: "delivered" | "suppressed_quiet_hours";
  suppressedReason?: string;
  read?: boolean;
}) => {
  await db.notification_delivery_logs.add({
    userId: input.userId,
    eventType: input.eventType,
    deliveredAt: input.deliveredAt,
    status: input.status,
    suppressedReason: input.suppressedReason,
    read: input.read ?? false,
  });
};

describe("DeliveryLogViewer", () => {
  it("renders one row per delivery log in reverse-chronological order", async () => {
    await seedLog({ userId: 1, eventType: "task.assigned", deliveredAt: "2026-04-01T08:00:00Z", status: "delivered" });
    await seedLog({ userId: 2, eventType: "equipment.alert", deliveredAt: "2026-04-02T09:00:00Z", status: "delivered" });
    await seedLog({ userId: 3, eventType: "meeting.reminder", deliveredAt: "2026-04-03T10:00:00Z", status: "suppressed_quiet_hours", suppressedReason: "quiet hours", read: true });

    renderWithProviders(<DeliveryLogViewer />, buildSession("administrator"));

    await waitFor(() => expect(screen.getByText("task.assigned")).toBeTruthy());
    expect(screen.getByText("equipment.alert")).toBeTruthy();
    expect(screen.getByText("meeting.reminder")).toBeTruthy();

    // Reverse-chronological: the first data row should be April 3 event.
    const firstRowCells = Array.from(document.querySelectorAll("tbody tr:first-child td"));
    expect(firstRowCells[1]?.textContent).toBe("meeting.reminder");
  });

  it("renders delivered/suppressed status and read/unread columns accurately", async () => {
    await seedLog({ userId: 10, eventType: "task.assigned", deliveredAt: "2026-04-10T10:00:00Z", status: "delivered", read: true });
    await seedLog({ userId: 11, eventType: "equipment.alert", deliveredAt: "2026-04-11T11:00:00Z", status: "suppressed_quiet_hours", suppressedReason: "21:00-06:00", read: false });

    renderWithProviders(<DeliveryLogViewer />, buildSession("administrator"));

    await waitFor(() => expect(screen.getByText("task.assigned")).toBeTruthy());
    // The "yes" cell corresponds to user 10's read column; "no" to user 11.
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    const byUser: Record<string, string[]> = {};
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td")).map((td) => td.textContent ?? "");
      byUser[cells[0]] = cells;
    }
    expect(byUser["10"][3]).toBe("delivered");
    expect(byUser["10"][5]).toBe("yes");
    expect(byUser["11"][3]).toBe("suppressed_quiet_hours");
    expect(byUser["11"][4]).toBe("21:00-06:00");
    expect(byUser["11"][5]).toBe("no");
  });

  it("applying a userId filter narrows the table to that user's rows only", async () => {
    await seedLog({ userId: 1, eventType: "task.assigned", deliveredAt: "2026-04-01T10:00:00Z", status: "delivered" });
    await seedLog({ userId: 2, eventType: "task.assigned", deliveredAt: "2026-04-02T10:00:00Z", status: "delivered" });
    renderWithProviders(<DeliveryLogViewer />, buildSession("administrator"));
    await waitFor(() => expect(screen.getAllByText("task.assigned").length).toBe(2));

    const userIdInput = document.querySelector('input[placeholder="User ID"]') as HTMLInputElement;
    act(() => {
      fireEvent.change(userIdInput, { target: { value: "2" } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      const cells = Array.from(document.querySelectorAll("tbody tr td:first-child")).map((td) => td.textContent);
      expect(cells).toEqual(["2"]);
    });
  });

  it("filtering by eventType hides rows with a different eventType", async () => {
    await seedLog({ userId: 5, eventType: "task.assigned", deliveredAt: "2026-04-01T10:00:00Z", status: "delivered" });
    await seedLog({ userId: 5, eventType: "equipment.alert", deliveredAt: "2026-04-02T10:00:00Z", status: "delivered" });
    renderWithProviders(<DeliveryLogViewer />, buildSession("administrator"));
    await waitFor(() => expect(screen.getByText("task.assigned")).toBeTruthy());

    const eventInput = document.querySelector('input[placeholder="Event type"]') as HTMLInputElement;
    act(() => {
      fireEvent.change(eventInput, { target: { value: "equipment.alert" } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(screen.queryByText("task.assigned")).toBeNull();
      expect(screen.getByText("equipment.alert")).toBeTruthy();
    });
  });

  it("surfaces AUTH_403 inline when the role lacks notifications:delivery_logs access (operator)", async () => {
    await seedLog({ userId: 1, eventType: "task.assigned", deliveredAt: "2026-04-01T10:00:00Z", status: "delivered" });
    renderWithProviders(<DeliveryLogViewer />, buildSession("operator"));
    await waitFor(() => expect(screen.getByText(/AUTH_403/)).toBeTruthy());
    expect(screen.queryByText("task.assigned")).toBeNull();
  });
});
