import { beforeEach, describe, expect, it } from "vitest";
import { notificationManager } from "../src/services/NotificationManager";
import { conflictService } from "../src/services/ConflictService";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { db } from "../src/db/schema";
import { WOGCError } from "../src/utils/errors";
import { notificationService } from "../src/services/NotificationService";
import { eventBus } from "../src/services/EventBus";

const clearTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

describe("business bounds hardening", () => {
  beforeEach(async () => {
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 1,
      username: "administrator",
      role: "administrator",
    }));
    await clearTables();
  });

  it("enforces strict conflict reason length > 10 in service", async () => {
    const taskId = await dal.saveTask({
      title: "Conflict target",
      status: "open",
      workstream: "putaway",
      resourceId: "R-1",
      createdAt: new Date().toISOString(),
    });

    await expect(conflictService.resolve({ taskId, keepResource: true, reason: "          " })).rejects.toBeInstanceOf(WOGCError);
    await expect(conflictService.resolve({ taskId, keepResource: true, reason: "0123456789" })).rejects.toBeInstanceOf(WOGCError);
  });

  it("enforces 50MB attachment size limit", async () => {
    const meetingId = await dal.saveMeeting({
      subject: "Size Test",
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(dal.saveAttachment({
      meetingId,
      filename: "big.pdf",
      mimeType: "application/pdf",
      size: 50 * 1024 * 1024 + 1,
      uploader: "administrator",
      contentHash: "x",
      blobData: new Blob([new Uint8Array(1)], { type: "application/pdf" }),
    })).rejects.toBeInstanceOf(WOGCError);
  });

  it("handles quiet-hours edge cases including cross-midnight and start=end", () => {
    expect(notificationManager.isWithinQuietHours(new Date("2026-04-03T23:59:59"), "21:00", "06:00")).toBe(true);
    expect(notificationManager.isWithinQuietHours(new Date("2026-04-03T00:00:00"), "21:00", "06:00")).toBe(true);
    expect(notificationManager.isWithinQuietHours(new Date("2026-03-29T01:30:00"), "01:00", "03:00")).toBe(true);
    expect(notificationManager.isWithinQuietHours(new Date("2026-03-29T04:00:00"), "01:00", "03:00")).toBe(false);
    expect(notificationManager.isWithinQuietHours(new Date("2026-04-03T10:00:00"), "10:00", "10:00")).toBe(false);
  });

  it("caps concurrent task notifications at 3/day", async () => {
    const userId = await db.users.add({
      username: "n_user",
      displayName: "N User",
      badgeId: "N-1001",
      passwordHash: "x",
      salt: "y",
      iterations: 120000,
      role: "viewer",
      mustResetPassword: false,
      createdAt: new Date().toISOString(),
    });

    await dal.upsertSubscription({ userId, category: "task_assignment", enabled: true });
    notificationService.start();

    for (let i = 0; i < 5; i += 1) {
      eventBus.publish("tasks.expired", {
        taskIds: [55],
        expiredAt: new Date().toISOString(),
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));

    const rows = await dal.listNotifications(100, userId, { bypassAuth: true });
    const sameTaskToday = rows.filter((row) => row.taskId === 55 && row.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10));
    expect(sameTaskToday.length).toBe(3);

    notificationService.stop();
  });
});
