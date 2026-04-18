import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/schema";
import { eventBus } from "../src/services/EventBus";
import { setDALAuthResolver } from "../src/db/dal";
import { WOGCError } from "../src/utils/errors";
import type { WOGCEventType } from "../src/types/events";

const clearTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

describe("persistent DLQ recovery", () => {
  beforeEach(async () => {
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 1,
      username: "administrator",
      role: "administrator",
    }));
    await clearTables();
    await eventBus.clearProcessedRegistry();
  });

  it("persists non-retryable failures to IndexedDB DLQ and hydrates view", async () => {
    const unsub = eventBus.subscribe("tasks.expired", () => {
      throw new WOGCError({
        code: "AUTH_403",
        message: "Forbidden",
        context: { op: "write" },
        retryable: false,
      });
    }, { consumerId: "test.dlq.persist" });

    eventBus.publish("tasks.expired", { taskIds: [1], expiredAt: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await eventBus.hydrateDLQView();

    const rows = await db.dead_letter_queue.toArray();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.errorContract.code).toBe("AUTH_403");
    expect(rows[0]?.status).toBe("pending");

    const snapshot = eventBus.getDLQSnapshot();
    expect(snapshot.length).toBeGreaterThanOrEqual(1);
    expect(snapshot[0]?.errorContract.code).toBe("AUTH_403");
    unsub();
  });

  it("re-hydrates after simulated session teardown and blocks manipulated replay payloads", async () => {
    await db.dead_letter_queue.add({
      eventPayload: {
        id: "evt-persisted-1",
        type: "tasks.expired" as WOGCEventType,
        payload: { taskIds: [9], expiredAt: new Date().toISOString() },
        emittedAt: new Date().toISOString(),
        retryCount: 5,
      },
      errorContract: {
        code: "EVENT_MAX_RETRIES",
        message: "Exceeded max retries",
        context: {},
        retryable: false,
      },
      failedAt: new Date().toISOString(),
      retryCount: 5,
      status: "pending",
    });

    await eventBus.hydrateDLQView();
    const first = eventBus.getDLQSnapshot();
    expect(first.length).toBe(1);

    await eventBus.hydrateDLQView();
    const second = eventBus.getDLQSnapshot();
    expect(second.length).toBe(1);

    const id = second[0]?.id;
    if (!id) {
      throw new Error("Expected persisted DLQ row");
    }
    await db.dead_letter_queue.update(id, {
      errorContract: { code: 12 as unknown as string, message: "bad", retryable: true as unknown as boolean },
    });

    await expect(eventBus.retryDLQEvent(id)).rejects.toBeInstanceOf(WOGCError);
  });
});
