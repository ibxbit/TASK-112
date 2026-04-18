import { beforeEach, describe, expect, it, vi } from "vitest";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { db } from "../src/db/schema";
import { eventBus } from "../src/services/EventBus";
import { WOGCError } from "../src/utils/errors";

const clearTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

describe("DLQ robustness", () => {
  beforeEach(async () => {
    await clearTables();
    await eventBus.clearProcessedRegistry();
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 1,
      username: "administrator",
      role: "administrator",
    }));
  });

  it("rejects replay of malformed payload without mutation", async () => {
    const dlqId = await db.dead_letter_queue.add({
      eventPayload: { id: "evt-1", type: 123 as unknown as never, payload: { taskId: 1 }, emittedAt: new Date().toISOString(), retryCount: 0 } as never,
      errorContract: { code: "X", message: "Y", retryable: false, context: {} },
      failedAt: new Date().toISOString(),
      retryCount: 0,
      status: "pending",
    });
    await db.system_settings.add({ key: "dlq.marker", value: "intact", updatedAt: new Date().toISOString() });

    await expect(eventBus.retryDLQEvent(dlqId)).rejects.toBeInstanceOf(WOGCError);
    const marker = await db.system_settings.where("key").equals("dlq.marker").first();
    expect(marker?.value).toBe("intact");
  });

  it("wraps quota failures as recoverable WOGCError and keeps data consistent", async () => {
    const addSpy = vi.spyOn(db.notifications, "add").mockRejectedValueOnce(new DOMException("Quota exceeded", "QuotaExceededError"));

    await expect(dal.saveNotification({
      userId: 1,
      category: "system",
      message: "quota",
      eventType: "quota.test",
      level: "info",
    })).rejects.toBeInstanceOf(WOGCError);

    const rows = await dal.listNotifications(20, 1, { bypassAuth: true });
    expect(rows.some((row) => row.message === "quota")).toBe(false);
    addSpy.mockRestore();
  });
});
