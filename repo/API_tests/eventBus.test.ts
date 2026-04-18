import { beforeEach, describe, expect, it, vi } from "vitest";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { db } from "../src/db/schema";
import { eventBus } from "../src/services/EventBus";

const clearTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

describe("event bus integration", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    await clearTables();
    await eventBus.clearProcessedRegistry();
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 1,
      username: "administrator",
      role: "administrator",
    }));
  });

  it("happy path: processes equipment command and clears outbox", async () => {
    const outboxId = await dal.enqueueEquipmentCommand({
      topic: "equipment.command",
      equipmentId: "AGV-HELLO",
      command: "PING",
      args: {},
      actingRole: "dispatcher",
    });

    const unsub = eventBus.subscribe("equipment.command.requested", async (event) => {
      await dal.deleteOutboxMessage(event.payload.outboxId, "dispatcher");
    }, { consumerId: "integration.outbox.clear" });

    await eventBus.publishEnvelope({
      id: "evt-equip-ok",
      type: "equipment.command.requested",
      payload: {
        outboxId,
        equipmentId: "AGV-HELLO",
        command: "PING",
        args: {},
      },
      emittedAt: new Date().toISOString(),
      retryCount: 0,
    });

    const pending = await dal.getPendingOutbox(20);
    expect(pending.find((row) => row.id === outboxId)).toBeUndefined();
    unsub();
  });

  it("failure path: stops retries at 5 and persists to DLQ", async () => {
    const unsub = eventBus.subscribe("tasks.expired", () => {
      throw new Error("integration forced failure");
    }, { consumerId: "integration.fail.tasks.expired" });

    await eventBus.publishEnvelope({
      id: "evt-integration-max-retry",
      type: "tasks.expired",
      payload: {
        taskIds: [91],
        expiredAt: new Date().toISOString(),
      },
      emittedAt: new Date().toISOString(),
      retryCount: 5,
    });

    const dlqRows = await db.dead_letter_queue.toArray();
    expect(dlqRows.length).toBeGreaterThan(0);
    const row = dlqRows[0];
    expect(row.retryCount).toBe(5);
    expect(row.errorContract.code).toBe("EVENT_MAX_RETRIES");
    expect(row.status).toBe("pending");

    const stillOperational = await dal.listDLQEntries();
    expect(stillOperational.length).toBeGreaterThan(0);
    unsub();
  });
});
