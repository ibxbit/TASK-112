// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import EquipmentPanel from "../src/pages/EquipmentPanel";
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
const seedHeartbeat = async (equipmentId: string, ageMs: number, latencyMs = 42) => {
  await db.equipment_heartbeats.add({
    scopeUserId: SCOPED_USER_ID,
    equipmentId,
    status: "ok",
    latencyMs,
    observedAt: new Date(Date.now() - ageMs).toISOString(),
  });
};

describe("EquipmentPanel", () => {
  it("renders one card per equipment using the most recent heartbeat (latest-wins reducer)", async () => {
    // Two heartbeats for the same AGV — only the latest should drive the card.
    await db.equipment_heartbeats.bulkAdd([
      {
        scopeUserId: SCOPED_USER_ID,
        equipmentId: "AGV-1",
        status: "ok",
        latencyMs: 10,
        observedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        scopeUserId: SCOPED_USER_ID,
        equipmentId: "AGV-1",
        status: "ok",
        latencyMs: 99,
        observedAt: new Date(Date.now() - 2_000).toISOString(),
      },
      {
        scopeUserId: SCOPED_USER_ID,
        equipmentId: "AGV-2",
        status: "ok",
        latencyMs: 21,
        observedAt: new Date(Date.now() - 1_000).toISOString(),
      },
    ]);

    renderWithProviders(<EquipmentPanel />, buildSession("dispatcher"));

    // Wait for the first async load to populate the DOM.
    await waitFor(() => expect(screen.getByText("AGV-1")).toBeTruthy());
    expect(screen.getByText("AGV-2")).toBeTruthy();
    expect(screen.getAllByText(/Heartbeat age:/)).toHaveLength(2);
    // The latest heartbeat's latency is what is shown (99ms), not the older (10ms).
    expect(screen.getByText("Latency: 99ms")).toBeTruthy();
  });

  it("aggregates timeout banner when any card is >= 20 s old", async () => {
    await seedHeartbeat("AGV-STALE", 25_000); // stale
    await seedHeartbeat("AGV-FRESH", 2_000); // fresh
    renderWithProviders(<EquipmentPanel />, buildSession("dispatcher"));

    await waitFor(() =>
      expect(screen.getByText(/Timeout Alert: 1 equipment endpoint/)).toBeTruthy(),
    );
  });

  it("hides the Queue Command surface for a viewer role (has equipment:read but not equipment:command)", async () => {
    await seedHeartbeat("AGV-VIEW", 3_000);
    renderWithProviders(<EquipmentPanel />, buildSession("viewer"));
    await waitFor(() => expect(screen.getByText("AGV-VIEW")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Queue Command" })).toBeNull();
    expect(screen.getByText(/Read-only scope/)).toBeTruthy();
  });

  it("enforces validation before queuing a command (empty inputs produce a warning toast, no DAL write)", async () => {
    await seedHeartbeat("AGV-OK", 1_000);
    const { store } = renderWithProviders(<EquipmentPanel />, buildSession("dispatcher"));
    await waitFor(() => screen.getByRole("button", { name: "Queue Command" }));

    const before = await db.message_outbox.count();
    act(() => {
      screen.getByRole("button", { name: "Queue Command" }).click();
    });

    await waitFor(() => {
      const warn = store.getState().ui.toasts.find((t: { variant: string }) => t.variant === "warning");
      expect(warn?.message).toMatch(/Enter equipment id and command/);
    });
    const after = await db.message_outbox.count();
    expect(after).toBe(before); // no write
  });

  it("queues a command end-to-end via the real DAL and shows the #id success banner", async () => {
    await seedHeartbeat("AGV-OK", 1_000);
    const { store } = renderWithProviders(<EquipmentPanel />, buildSession("dispatcher"));
    await waitFor(() => screen.getByRole("button", { name: "Queue Command" }));

    const [equipInput, cmdInput] = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
    expect(equipInput).toBeTruthy();
    expect(cmdInput).toBeTruthy();

    act(() => {
      fireEvent.change(equipInput, { target: { value: "AGV-OK" } });
      fireEvent.change(cmdInput, { target: { value: "RESET" } });
    });

    expect(equipInput.value).toBe("AGV-OK");
    expect(cmdInput.value).toBe("RESET");

    fireEvent.click(screen.getByRole("button", { name: "Queue Command" }));

    // Consistency: the real DAL must insert into message_outbox and the UI
    // must reflect a success toast with the freshly-allocated row id.
    await waitFor(async () => {
      const pending = await db.message_outbox.toArray();
      const match = pending.find((m) => m.payload.equipmentId === "AGV-OK" && m.payload.command === "RESET");
      expect(match).toBeTruthy();
    });
    await waitFor(() => {
      const success = store.getState().ui.toasts.find((t: { variant: string }) => t.variant === "success");
      expect(success?.message ?? "").toMatch(/Command queued as #\d+ for AGV-OK/);
    });
  });
});
