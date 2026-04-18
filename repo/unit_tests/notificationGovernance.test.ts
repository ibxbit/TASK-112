import { beforeEach, describe, expect, it } from "vitest";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { db } from "../src/db/schema";
import { notificationService } from "../src/services/NotificationService";
import { eventBus } from "../src/services/EventBus";

const clearTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 1_000, intervalMs = 20): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
  throw new Error("Timed out waiting for notification dispatch");
};

describe("notification governance", () => {
  beforeEach(async () => {
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 1,
      username: "administrator",
      role: "administrator",
    }));
    await clearTables();
    await dal.registerLocalUser({
      username: "administrator",
      displayName: "Administrator",
      role: "administrator",
      passwordHash: "x",
      salt: "y",
      iterations: 120000,
      mustResetPassword: false,
    });
  });

  it("enforces in-app-only channel on notification writes", async () => {
    const id = await dal.saveNotification({
      userId: 1,
      category: "system",
      eventType: "manual",
      level: "info",
      message: "Hello",
    });
    const rows = await dal.listNotifications(10, 1);
    const row = rows.find((item) => item.id === id);
    expect(row?.channel).toBe("ui");
  });

  it("creates read receipt and updates unread count", async () => {
    const notificationId = await dal.saveNotification({
      userId: 1,
      category: "system",
      eventType: "manual",
      level: "info",
      message: "Read me",
    });
    expect(await dal.unreadNotificationCount(1)).toBe(1);
    await dal.markNotificationRead(notificationId, 1);
    expect(await dal.unreadNotificationCount(1)).toBe(0);
  });

  it("enforces max three notifications for same task/day", async () => {
    const userId = await dal.saveUserConfig({
      username: "op1",
      displayName: "Operator 1",
      role: "operator",
      passwordHash: "x",
      salt: "y",
      iterations: 120000,
      mustResetPassword: false,
    });

    await dal.upsertSubscription({
      userId,
      category: "task_assignment",
      enabled: true,
    });

    notificationService.start();

    for (let i = 0; i < 4; i += 1) {
      eventBus.publish("tasks.expired", {
        taskIds: [17],
        expiredAt: new Date().toISOString(),
      });
      await Promise.resolve();
    }

    await waitFor(async () => {
      const rows = await dal.listNotifications(100, userId);
      const sameTaskToday = rows.filter((row) => row.taskId === 17 && row.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10));
      return sameTaskToday.length >= 3;
    });

    const rows = await dal.listNotifications(100, userId);
    const sameTaskToday = rows.filter((row) => row.taskId === 17 && row.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10));
    expect(sameTaskToday.length).toBe(3);

    notificationService.stop();
  });

  it("stores delivery logs and filters by event type", async () => {
    const notificationId = await dal.saveNotification({
      userId: 1,
      category: "equipment_alert",
      eventType: "equipment.heartbeat.timeout",
      level: "error",
      message: "timeout",
    });
    await dal.saveDeliveryLog({
      notificationId,
      userId: 1,
      eventType: "equipment.heartbeat.timeout",
      status: "delivered",
    });
    await dal.saveDeliveryLog({
      notificationId,
      userId: 1,
      eventType: "tasks.expired",
      status: "delivered",
    });

    const fromISO = new Date(Date.now() - 60_000).toISOString();
    const toISO = new Date(Date.now() + 60_000).toISOString();
    const filtered = await dal.listDeliveryLogs({ eventType: "equipment.heartbeat.timeout", userId: 1, fromISO, toISO });
    expect(filtered.length).toBe(1);
    expect(filtered[0].eventType).toBe("equipment.heartbeat.timeout");
  });

  it("delivers recipient notifications regardless of actor scope", async () => {
    const recipientId = await dal.saveUserConfig({
      username: "viewer_a",
      displayName: "Viewer A",
      role: "viewer",
      passwordHash: "x",
      salt: "y",
      iterations: 120000,
      mustResetPassword: false,
    });

    await dal.upsertSubscription({ userId: recipientId, category: "task_assignment", enabled: true });

    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 2,
      username: "dispatcher",
      role: "dispatcher",
    }));

    notificationService.start();
    eventBus.publish("tasks.expired", { taskIds: [91], expiredAt: new Date().toISOString() });

    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: recipientId,
      username: "viewer_a",
      role: "viewer",
    }));

    await waitFor(async () => {
      const rows = await dal.listNotifications(100, recipientId);
      return rows.some((row) => row.taskId === 91);
    });

    const rows = await dal.listNotifications(100, recipientId);
    expect(rows.some((row) => row.taskId === 91)).toBe(true);
    notificationService.stop();
  });

  it("suppresses notifications during quiet hours and logs suppression", async () => {
    const userId = await dal.saveUserConfig({
      username: "quiet_user",
      displayName: "Quiet User",
      role: "viewer",
      passwordHash: "x",
      salt: "y",
      iterations: 120000,
      mustResetPassword: false,
    });
    await dal.upsertSubscription({ userId, category: "equipment_alert", enabled: true });

    const nowDate = new Date();
    const start = new Date(nowDate.getTime() - 60_000);
    const end = new Date(nowDate.getTime() + 60_000);
    const hhmm = (value: Date): string => `${value.getHours().toString().padStart(2, "0")}:${value.getMinutes().toString().padStart(2, "0")}`;
    await dal.setUserQuietHours(userId, hhmm(start), hhmm(end));

    notificationService.start();
    eventBus.publish("equipment.heartbeat.timeout", {
      equipmentId: "EQ-1",
      lastHeartbeatAt: new Date().toISOString(),
      timeoutMs: 20_000,
    });

    await waitFor(async () => {
      const logs = await dal.listDeliveryLogs({ userId, eventType: "equipment.heartbeat.timeout" });
      return logs.some((row) => row.status === "suppressed_quiet_hours");
    });

    const notifications = await dal.listNotifications(100, userId);
    const logs = await dal.listDeliveryLogs({ userId, eventType: "equipment.heartbeat.timeout" });
    expect(notifications.length).toBe(0);
    expect(logs.some((row) => row.status === "suppressed_quiet_hours")).toBe(true);
    notificationService.stop();
  });
});
