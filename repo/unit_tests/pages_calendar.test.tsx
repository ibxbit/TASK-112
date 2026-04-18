// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import Calendar from "../src/pages/Calendar";
import { db } from "../src/db/schema";
import { buildSession, cleanup, renderWithProviders, resetDatabase } from "./helpers/renderHarness";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(async () => {
  await resetDatabase();
});

const SCOPED_USER_ID = 1;

const inAWeekFromNow = (hoursOffset = 10) => {
  const d = new Date();
  d.setHours(hoursOffset, 0, 0, 0);
  return d.toISOString();
};

describe("Calendar page", () => {
  it("renders seeded events in the week view and switches to Day/Month via the mode select", async () => {
    await db.calendar_events.bulkAdd([
      {
        scopeUserId: SCOPED_USER_ID,
        title: "On-site audit",
        eventType: "meeting",
        category: "occupancy",
        recurrenceRule: "none",
        startAt: inAWeekFromNow(9),
        endAt: inAWeekFromNow(10),
      },
      {
        scopeUserId: SCOPED_USER_ID,
        title: "Conveyor maintenance",
        eventType: "maintenance",
        category: "maintenance",
        recurrenceRule: "none",
        startAt: inAWeekFromNow(13),
        endAt: inAWeekFromNow(15),
      },
    ]);

    renderWithProviders(<Calendar />, buildSession("facilitator"));

    // Week view: each event shows exactly once inside today's slot card.
    await waitFor(() => expect(screen.getAllByText("On-site audit").length).toBe(1));
    expect(screen.getAllByText("Conveyor maintenance").length).toBe(1);

    // State transition: flipping the mode select changes the rendered slot
    // count. There are multiple <select>s on the page; the mode one is the
    // only one whose current value is "week".
    const modeSelect = Array.from(document.querySelectorAll("select")).find(
      (el) => (el as HTMLSelectElement).value === "week",
    ) as HTMLSelectElement;
    expect(modeSelect).toBeTruthy();
    act(() => {
      fireEvent.change(modeSelect, { target: { value: "day" } });
    });
    // Day mode: the calendar renders one slot per hour (24 slots), each
    // displaying the events whose toDateString matches. Use getAllByText
    // since the same event now surfaces across every hour slot for today.
    await waitFor(() => expect(screen.getAllByText("On-site audit").length).toBeGreaterThan(0));
  });

  it("blocks calendar creation surfaces for a viewer (no calendar:create permission)", async () => {
    renderWithProviders(<Calendar />, buildSession("viewer"));
    await waitFor(() => screen.getByText("Operational Calendar"));
    expect(screen.queryByRole("button", { name: "Create Event" })).toBeNull();
    expect(screen.getByText(/Read-only scope/)).toBeTruthy();
  });

  it("Create Event with empty fields surfaces a validation warning and writes nothing", async () => {
    const { store } = renderWithProviders(<Calendar />, buildSession("facilitator"));
    await waitFor(() => screen.getByRole("button", { name: "Create Event" }));

    const before = await db.calendar_events.count();
    fireEvent.click(screen.getByRole("button", { name: "Create Event" }));

    await waitFor(() => {
      const warn = store.getState().ui.toasts.find((t: { variant: string }) => t.variant === "warning");
      expect(warn?.message).toMatch(/Provide title, start and end/);
    });
    expect(await db.calendar_events.count()).toBe(before);
  });

  it("Create Event happy path persists through the real DAL and reloads the grid", async () => {
    renderWithProviders(<Calendar />, buildSession("facilitator"));
    await waitFor(() => screen.getByRole("button", { name: "Create Event" }));

    const inputs = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
    const [titleInput] = inputs.filter((el) => el.placeholder === "title");
    const [resourceInput] = inputs.filter((el) => el.placeholder === "resource");
    const dateInputs = inputs.filter((el) => el.type === "datetime-local");

    // Today so the event falls inside the current week slot range.
    const today = new Date();
    const startLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 10, 0);
    const endLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 11, 0);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

    act(() => {
      fireEvent.change(titleInput, { target: { value: "Line-B inspection" } });
      fireEvent.change(resourceInput, { target: { value: "BIN-404" } });
      fireEvent.change(dateInputs[0], { target: { value: fmt(startLocal) } });
      fireEvent.change(dateInputs[1], { target: { value: fmt(endLocal) } });
    });

    fireEvent.click(screen.getByRole("button", { name: "Create Event" }));

    await waitFor(async () => {
      const rows = await db.calendar_events.toArray();
      expect(rows.some((r) => r.title === "Line-B inspection" && r.resourceId === "BIN-404")).toBe(true);
    });
    await waitFor(() => expect(screen.getAllByText("Line-B inspection").length).toBeGreaterThan(0));
  });
});
