import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventBus } from "../src/services/EventBus";
import { store } from "../src/store";
import { logout } from "../src/store/authSlice";
import { WOGCError } from "../src/utils/errors";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { db } from "../src/db/schema";

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const waitFor = async (check: () => boolean, timeoutMs = 1000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
};

const waitForAsync = async (check: () => Promise<boolean>, timeoutMs = 1000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
};

describe("EventBus failure isolation and contract safety", () => {
  beforeEach(async () => {
    store.dispatch(logout());
    vi.useRealTimers();
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 1,
      username: "administrator",
      role: "administrator",
    }));
    await eventBus.clearProcessedRegistry();
    for (const table of db.tables) {
      await table.clear();
    }
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    await eventBus.clearProcessedRegistry();
  });

  it("happy path: retryable WOGCError triggers exponential backoff and eventually succeeds", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const unsub = eventBus.subscribe("equipment.command.failed", () => {
      attempts += 1;
      if (attempts < 3) {
        throw new WOGCError({
          code: "EQUIP_FAIL",
          message: "Transient equipment failure",
          context: { attempts },
          retryable: true,
        });
      }
    });

    eventBus.publish("equipment.command.failed", {
      outboxId: 44,
      equipmentId: "AGV-2",
      command: "MOVE_TO_DOCK",
      reason: {
        code: "EQUIP_FAIL",
        message: "Transient equipment failure",
        context: {},
        retryable: true,
      },
    });

    await flushMicrotasks();
    await vi.runAllTimersAsync();
    await flushMicrotasks();

    expect(attempts).toBe(3);
    expect(store.getState().eventBus.deadLetterQueue).toHaveLength(0);
    unsub();
  });

  it("adversarial path: retryable false goes directly to DLQ", async () => {
    const unsub = eventBus.subscribe("tasks.expired", () => {
      throw new WOGCError({
        code: "AUTH_403",
        message: "Forbidden",
        context: { operation: "write" },
        retryable: false,
      });
    });

    const eventId = eventBus.publish("tasks.expired", {
      taskIds: [1],
      expiredAt: new Date().toISOString(),
    });

    await flushMicrotasks();
    await waitFor(() => store.getState().eventBus.deadLetterQueue.length >= 1);

    const dlq = store.getState().eventBus.deadLetterQueue;
    expect(dlq).toHaveLength(1);
    expect(dlq[0].eventPayload.id).toBe(eventId);
    expect(dlq[0].errorContract.code).toBe("AUTH_403");
    expect(dlq[0].errorContract.retryable).toBe(false);
    unsub();
  });

  it("adversarial path: raw TypeError is normalized and handled safely", async () => {
    vi.useFakeTimers();
    const unsub = eventBus.subscribe("equipment.heartbeat.timeout", () => {
      throw new TypeError("cannot read property timeoutMs of undefined");
    });

    const eventId = eventBus.publish("equipment.heartbeat.timeout", {
      equipmentId: "CV-3",
      lastHeartbeatAt: new Date().toISOString(),
      timeoutMs: 20000,
    });

    await flushMicrotasks();
    await vi.runAllTimersAsync();
    await flushMicrotasks();

    const dlq = store.getState().eventBus.deadLetterQueue;
    expect(dlq).toHaveLength(1);
    expect(dlq[0].eventPayload.id).toBe(eventId);
    expect(dlq[0].errorContract.code).toBe("EVENT_MAX_RETRIES");
    expect(dlq[0].errorContract.retryable).toBe(false);
    expect(dlq[0].errorContract.message).toContain("Exceeded max retries");
    unsub();
  });

  it("idempotency: duplicate event id does not double-run consumer side effects", async () => {
    let processed = 0;
    const unsub = eventBus.subscribe("tasks.expired", () => {
      processed += 1;
    }, { consumerId: "test.idempotent.counter" });

    const eventId = "evt-manual-1";
    eventBus.publish("tasks.expired", { taskIds: [10], expiredAt: new Date().toISOString() }, { eventId });
    eventBus.publish("tasks.expired", { taskIds: [10], expiredAt: new Date().toISOString() }, { eventId });

    await flushMicrotasks();
    await waitFor(() => processed >= 1);
    expect(processed).toBe(1);
    unsub();
  });

  it("idempotency: duplicate notification dispatch does not create duplicate notifications", async () => {
    const userId = await dal.saveUserConfig({
      username: "u1",
      displayName: "User 1",
      badgeId: "USR1-1001",
      role: "viewer",
      passwordHash: "x",
      salt: "y",
      iterations: 120000,
      mustResetPassword: false,
    });

    const unsub = eventBus.subscribe("tasks.expired", async (event) => {
      await dal.saveNotification({
        userId,
        category: "task_assignment",
        eventType: event.type,
        level: "warn",
        taskId: event.payload.taskIds[0],
        message: "Task expired",
      }, { bypassAuth: true });
    }, { consumerId: "test.idempotent.notifications" });

    const eventId = "evt-manual-2";
    eventBus.publish("tasks.expired", { taskIds: [17], expiredAt: new Date().toISOString() }, { eventId });
    eventBus.publish("tasks.expired", { taskIds: [17], expiredAt: new Date().toISOString() }, { eventId });
    await flushMicrotasks();
    await waitForAsync(async () => {
      const rows = await dal.listNotifications(100, userId);
      return rows.filter((row) => row.taskId === 17).length >= 1;
    });

    const rows = await dal.listNotifications(100, userId);
    expect(rows.filter((row) => row.taskId === 17).length).toBe(1);
    unsub();
  });
});
