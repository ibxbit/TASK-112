// @vitest-environment jsdom
/**
 * Behavior matrix for <DispatcherDashboard>.
 *
 * Real Redux + real Dexie. No mocks in this file — we drive the DAL with
 * authentic reads/writes and verify what shows up in the DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import DispatcherDashboard from "../src/pages/DispatcherDashboard";
import { db } from "../src/db/schema";
import { buildSession, cleanup, renderWithProviders, resetDatabase } from "./helpers/renderHarness";
import { eventBus } from "../src/services/EventBus";

const SCOPED = 1;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(async () => {
  await resetDatabase();
  await eventBus.clearProcessedRegistry();
});

const seedTask = async (overrides: {
  title: string;
  status?: "open" | "in_progress" | "done" | "expired";
  assignee?: string;
}) => {
  const id = await db.tasks.add({
    scopeUserId: SCOPED,
    title: overrides.title,
    status: overrides.status ?? "open",
    workstream: "transport",
    priority: 2,
    assignee: overrides.assignee,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return id as number;
};

const seedHeartbeat = async (equipmentId: string, ageMs: number, status: "ok" | "timeout" = "ok") => {
  await db.equipment_heartbeats.add({
    scopeUserId: SCOPED,
    equipmentId,
    status,
    latencyMs: 42,
    observedAt: new Date(Date.now() - ageMs).toISOString(),
  });
};

describe("DispatcherDashboard", () => {
  it("sorts the priority queue: expired first, then open, then in_progress, then done", async () => {
    await seedTask({ title: "A-done", status: "done" });
    await seedTask({ title: "B-open", status: "open" });
    await seedTask({ title: "C-expired", status: "expired" });
    await seedTask({ title: "D-in-progress", status: "in_progress" });

    renderWithProviders(<DispatcherDashboard />, buildSession("dispatcher"));

    await waitFor(() => expect(screen.getByText("C-expired")).toBeTruthy());
    // Get the first column cells ordered top-to-bottom.
    const cells = Array.from(document.querySelectorAll("tbody tr td:first-child")).map((td) => td.textContent ?? "");
    expect(cells[0]).toBe("C-expired");
    expect(cells[1]).toBe("B-open");
    expect(cells[2]).toBe("D-in-progress");
    expect(cells[3]).toBe("A-done");
  });

  it("labels heartbeat status: online (<20s), heartbeat_missed (>20s age), offline (explicit timeout)", async () => {
    await seedHeartbeat("AGV-FRESH", 2_000);
    await seedHeartbeat("AGV-STALE", 25_000);
    await seedHeartbeat("AGV-OFF", 1_000, "timeout");

    renderWithProviders(<DispatcherDashboard />, buildSession("dispatcher"));

    await waitFor(() => expect(screen.getByText("AGV-FRESH")).toBeTruthy());
    // Each heartbeat row's status is rendered in the second column.
    const rows = Array.from(document.querySelectorAll("tbody tr")).filter((tr) => tr.querySelector("td")?.textContent?.startsWith("AGV-"));
    const statusByEquipment: Record<string, string> = {};
    for (const row of rows) {
      const [eqCell, statusCell] = Array.from(row.querySelectorAll("td"));
      statusByEquipment[eqCell.textContent ?? ""] = statusCell.textContent ?? "";
    }
    expect(statusByEquipment["AGV-FRESH"]).toBe("online");
    expect(statusByEquipment["AGV-STALE"]).toBe("heartbeat_missed");
    expect(statusByEquipment["AGV-OFF"]).toBe("offline");
  });

  it("assign action persists a new assignee through the real DAL", async () => {
    const taskId = await seedTask({ title: "needs-owner", status: "open" });
    const { store } = renderWithProviders(<DispatcherDashboard />, buildSession("dispatcher"));
    await waitFor(() => screen.getByText("needs-owner"));

    const assigneeInput = document.querySelector('input[placeholder="assignee"]') as HTMLInputElement;
    act(() => {
      fireEvent.change(assigneeInput, { target: { value: "bob" } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));

    await waitFor(async () => {
      const after = await db.tasks.get(taskId);
      expect(after?.assignee).toBe("bob");
    });
    const success = store.getState().ui.toasts.find((t: { variant: string }) => t.variant === "success");
    expect(success?.message ?? "").toMatch(/assigned to bob/);
  });

  it("blank assignee produces a warning and does not write", async () => {
    await seedTask({ title: "empty-assign", status: "open" });
    const { store } = renderWithProviders(<DispatcherDashboard />, buildSession("dispatcher"));
    await waitFor(() => screen.getByText("empty-assign"));

    const tasksBefore = await db.tasks.toArray();
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));

    await waitFor(() => {
      const warn = store.getState().ui.toasts.find((t: { variant: string }) => t.variant === "warning");
      expect(warn?.message).toMatch(/Enter an assignee/);
    });
    const tasksAfter = await db.tasks.toArray();
    expect(tasksAfter).toEqual(tasksBefore);
  });

  it("role without tasks:assign sees the read-only note and no Assign action column", async () => {
    // Viewer titles longer than 10 chars are masked by the DAL — use a short
    // title to keep the assertion on the masked output simple.
    await seedTask({ title: "short-t", status: "open", assignee: "preset" });
    renderWithProviders(<DispatcherDashboard />, buildSession("viewer"));
    await waitFor(() => screen.getByText("short-t"));

    expect(screen.queryByRole("button", { name: "Assign" })).toBeNull();
    expect(screen.getByText(/Read-only scope/)).toBeTruthy();
  });

  it("subscribes to tasks.expired and heartbeat.timeout events (observable via toast enqueue)", async () => {
    await seedTask({ title: "watcher-task", status: "open" });
    const { store } = renderWithProviders(<DispatcherDashboard />, buildSession("dispatcher"));
    await waitFor(() => screen.getByText("watcher-task"));

    await eventBus.publishEnvelope({
      id: "evt-tasks-expired-1",
      type: "tasks.expired",
      payload: { taskIds: [1], expiredAt: new Date().toISOString() },
      emittedAt: new Date().toISOString(),
      retryCount: 0,
    });
    await eventBus.publishEnvelope({
      id: "evt-hb-timeout-1",
      type: "equipment.heartbeat.timeout",
      payload: { equipmentId: "AGV-X", lastHeartbeatAt: new Date().toISOString(), timeoutMs: 20_000 },
      emittedAt: new Date().toISOString(),
      retryCount: 0,
    });

    await waitFor(() => {
      const msgs = store.getState().ui.toasts.map((t: { message: string }) => t.message);
      expect(msgs.some((m) => m.includes("Task expiry event received"))).toBe(true);
      expect(msgs.some((m) => m.includes("Heartbeat missed event received"))).toBe(true);
    });
  });
});
