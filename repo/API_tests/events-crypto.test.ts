import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/schema";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { eventBus } from "../src/services/EventBus";
import { backupService } from "../src/services/BackupService";
import { WOGCError } from "../src/utils/errors";
import { conflictService } from "../src/services/ConflictService";

const clearTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 1500): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
};

describe("events + crypto robustness", () => {
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

  it("processes repeated identical eventId once for side effects", async () => {
    let invoked = 0;
    const unsub = eventBus.subscribe("tasks.completed", async () => {
      invoked += 1;
      await dal.saveSystemSetting({ key: `idempotency.counter`, value: String(invoked) });
    }, { consumerId: "test.idempotency" });

    const eventId = "evt-idempotent-1";
    const payload = { taskId: 77, completedAt: new Date().toISOString(), resolutionId: 101 };
    eventBus.publish("tasks.completed", payload, { eventId });
    eventBus.publish("tasks.completed", payload, { eventId });
    eventBus.publish("tasks.completed", payload, { eventId });

    await waitFor(async () => {
      const row = await db.system_settings.where("key").equals("idempotency.counter").first();
      return Boolean(row);
    });

    const row = await db.system_settings.where("key").equals("idempotency.counter").first();
    expect(invoked).toBe(1);
    expect(row?.value).toBe("1");
    unsub();
  });

  it("aborts import on wrong passphrase and tampered ciphertext", async () => {
    await db.system_settings.add({ key: "pre.import.marker", value: "safe", updatedAt: new Date().toISOString() });

    const malformed = new File([JSON.stringify({ v: 1, salt: "AAAA", iv: "AAAA", data: "AAAA" })], "tampered.enc.json", { type: "application/json" });
    await expect(backupService.importEncrypted(malformed, "wrong-passphrase")).rejects.toBeInstanceOf(WOGCError);

    const post = await db.system_settings.where("key").equals("pre.import.marker").first();
    expect(post?.value).toBe("safe");
  });

  it("rejects conflict resolution bypass with blank reason", async () => {
    const taskId = await dal.saveTask({
      title: "Conflict task",
      status: "open",
      workstream: "putaway",
      resourceId: "R-2",
      createdAt: new Date().toISOString(),
    });

    await expect(conflictService.resolve({ taskId, keepResource: true, reason: "   " })).rejects.toBeInstanceOf(WOGCError);
  });
});
