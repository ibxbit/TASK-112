/**
 * Cross-flow service-boundary integration tests (RBAC + consistency).
 *
 * These tests exercise the WOGC internal "API" (service + DAL + event bus
 * boundary) under realistic user journeys. They intentionally avoid UI-layer
 * rendering and HTTP: the project is a pure offline SPA, so "API" here means
 * the internal contracts described in docs/api-spec.md. curl/Postman are N/A.
 *
 * Matrix:
 *   1. Role enforcement (dispatcher writes → allowed, operator writes → AUTH_403).
 *   2. Validation boundary (conflict resolution rejects thin reasons).
 *   3. Retry / idempotency (identical event.id processed exactly once).
 *   4. Conflict handling (double-assigned bin blocked by lockout contract).
 *   5. Session transition (role swap mid-session purges previous-user scope).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { db } from "../src/db/schema";
import { conflictService } from "../src/services/ConflictService";
import { eventBus } from "../src/services/EventBus";
import { WOGCError } from "../src/utils/errors";

type AuthSnapshot = {
  isAuthenticated: boolean;
  userId: number | null;
  username: string | null;
  role: "administrator" | "dispatcher" | "facilitator" | "operator" | "viewer" | "auditor" | null;
};

let currentAuth: AuthSnapshot = { isAuthenticated: false, userId: null, username: null, role: null };
setDALAuthResolver(() => currentAuth);

const as = (role: AuthSnapshot["role"], userId: number = 1, username = `${role}-u`): void => {
  currentAuth = { isAuthenticated: role !== null, userId, username, role };
};

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
  await eventBus.clearProcessedRegistry();
  as(null);
});

afterEach(() => {
  as(null);
});

describe("RBAC: role enforcement across the DAL boundary", () => {
  it("dispatcher can write tasks; viewer cannot (DAL throws AUTH_403)", async () => {
    as("dispatcher", 10);
    const dispatcherTaskId = await dal.saveTask({
      title: "move pallet",
      status: "open",
      workstream: "transport",
      priority: 2,
      createdAt: new Date().toISOString(),
    });
    expect(typeof dispatcherTaskId).toBe("number");

    // Viewer has tasks:read but no write privilege anywhere.
    as("viewer", 11);
    await expect(
      dal.saveTask({
        title: "viewer direct write",
        status: "open",
        workstream: "transport",
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(WOGCError);

    try {
      as("viewer", 11);
      await dal.saveTask({
        title: "second attempt",
        status: "open",
        workstream: "transport",
        createdAt: new Date().toISOString(),
      });
      throw new Error("expected AUTH_403");
    } catch (error) {
      expect(error).toBeInstanceOf(WOGCError);
      expect((error as WOGCError).code).toBe("AUTH_403");
      expect((error as WOGCError).retryable).toBe(false);
    }
  });

  it("auditor role is entirely read-only at the service boundary", async () => {
    as("administrator", 1);
    const taskId = await dal.saveTask({
      title: "seeded",
      status: "open",
      workstream: "picking",
      priority: 3,
      createdAt: new Date().toISOString(),
    });

    as("auditor", 99);
    // Read surface allowed:
    const entries = await dal.listAuditTrail({});
    expect(entries.length).toBeGreaterThan(0);

    // Write surface denied with a non-retryable 403:
    await expect(
      dal.saveTask({
        id: taskId,
        title: "audit forbidden",
        status: "in_progress",
        workstream: "picking",
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "AUTH_403", retryable: false });
  });
});

describe("Validation boundary: conflict reason contract", () => {
  it("rejects blank reason via ConflictService → WOGCError VAL_REASON_REQUIRED (retryable=false)", async () => {
    as("dispatcher", 10);
    const taskId = await dal.saveTask({
      title: "conflict candidate",
      status: "open",
      workstream: "transport",
      resourceId: "BIN-X",
      createdAt: new Date().toISOString(),
    });

    await expect(conflictService.resolve({ taskId, keepResource: true, reason: "" })).rejects.toMatchObject({
      code: "VAL_REASON_REQUIRED",
      retryable: false,
    });
    await expect(conflictService.resolve({ taskId, keepResource: true, reason: "too short" })).rejects.toMatchObject({
      code: "VAL_REASON_REQUIRED",
    });
  });

  it("accepts a qualifying reason and records it as a successful resolution", async () => {
    as("dispatcher", 10);
    const taskId = await dal.saveTask({
      title: "conflict good path",
      status: "open",
      workstream: "putaway",
      resourceId: "BIN-Y",
      createdAt: new Date().toISOString(),
    });

    await conflictService.resolve({
      taskId,
      keepResource: true,
      reason: "Dispatcher accepted — re-routed B2 shift coverage per shift lead.",
    });

    // Switch to administrator to inspect the audit trail (dispatchers are
    // intentionally prohibited from reading it — that's the RBAC contract).
    as("administrator", 1);
    const logs = await dal.listAuditTrail({});
    expect(logs.some((row) => row.entityId === String(taskId))).toBe(true);
  });
});

describe("Edge cases: timeouts, retries, idempotency", () => {
  it("event bus dispatches the same envelope.id to a consumer exactly once (idempotent replay)", async () => {
    as("dispatcher", 20);
    let count = 0;
    const unsub = eventBus.subscribe(
      "tasks.expired",
      () => {
        count += 1;
      },
      { consumerId: "tests.crossflow.idempotent" },
    );

    const envelope = {
      id: "stable-idempotent-event",
      type: "tasks.expired" as const,
      payload: { taskIds: [42], expiredAt: new Date().toISOString() },
      emittedAt: new Date().toISOString(),
      retryCount: 0,
    };

    await eventBus.publishEnvelope(envelope);
    await eventBus.publishEnvelope(envelope);
    await eventBus.publishEnvelope(envelope);
    expect(count).toBe(1);
    unsub();
  });

  it("calendar event save raises LOCKOUT_CONFLICT (non-retryable) when a lockout is active on the resource", async () => {
    as("administrator", 1);
    const now = Date.now();
    const lockoutStart = new Date(now - 60 * 60 * 1000).toISOString();
    const lockoutEnd = new Date(now + 60 * 60 * 1000).toISOString();
    await dal.saveCalendarLockout({
      resourceId: "AGV-CRIT",
      reason: "scheduled maintenance",
      startAt: lockoutStart,
      endAt: lockoutEnd,
    });

    // Attempting to schedule a calendar event on that locked resource during
    // the active window must raise LOCKOUT_CONFLICT with retryable=false.
    await expect(
      dal.saveCalendarEvent({
        title: "collision attempt",
        eventType: "task",
        category: "occupancy",
        recurrenceRule: "none",
        resourceId: "AGV-CRIT",
        startAt: new Date(now).toISOString(),
        endAt: new Date(now + 5 * 60 * 1000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "LOCKOUT_CONFLICT", retryable: false });
  });
});

describe("Data consistency across session / role changes", () => {
  it("role swap mid-session does not leak another user's scoped rows", async () => {
    as("dispatcher", 77);
    await dal.saveTask({
      title: "dispatcher-77 private",
      status: "open",
      workstream: "transport",
      createdAt: new Date().toISOString(),
    });

    // Second user logs in in the same process (different scopeUserId).
    as("dispatcher", 99);
    const visibleToSecond = await dal.listTasks();
    expect(visibleToSecond.every((t) => t.title !== "dispatcher-77 private")).toBe(true);

    // Back to first user → their row is still there.
    as("dispatcher", 77);
    const visibleToFirst = await dal.listTasks();
    expect(visibleToFirst.some((t) => t.title === "dispatcher-77 private")).toBe(true);
  });

  it("logging out clears the auth snapshot so DAL mutations immediately throw AUTH_403", async () => {
    as("dispatcher", 10);
    await dal.saveTask({
      title: "pre-logout",
      status: "open",
      workstream: "picking",
      createdAt: new Date().toISOString(),
    });

    as(null); // simulate logout

    await expect(
      dal.saveTask({
        title: "post-logout",
        status: "open",
        workstream: "picking",
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "AUTH_403", retryable: false });
  });
});
