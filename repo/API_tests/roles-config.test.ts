import { beforeEach, describe, expect, it, vi } from "vitest";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { db } from "../src/db/schema";
import { WOGCError } from "../src/utils/errors";

const clearTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

describe("roles and config hardening", () => {
  beforeEach(async () => {
    await clearTables();
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 1,
      username: "administrator",
      role: "administrator",
    }));
  });

  it("enforces config auth split for operator vs public config", async () => {
    await dal.importRuntimeConfig(JSON.stringify({ version: 1, idleAutoLockMs: 1234 }));

    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 2,
      username: "op",
      role: "operator",
    }));

    await expect(dal.getOperationalSettings()).rejects.toBeInstanceOf(WOGCError);
    await expect(dal.getPublicConfig()).resolves.toMatchObject({ version: 1, idleAutoLockMs: 1234 });
  });

  it("blocks attachment id guessing and allows delivery logs for privileged roles", async () => {
    const userA = await db.users.add({
      username: "userA",
      displayName: "User A",
      badgeId: "A-1001",
      passwordHash: "x",
      salt: "y",
      iterations: 120000,
      role: "facilitator",
      mustResetPassword: false,
      createdAt: new Date().toISOString(),
    });
    const userB = await db.users.add({
      username: "userB",
      displayName: "User B",
      badgeId: "B-1001",
      passwordHash: "x",
      salt: "y",
      iterations: 120000,
      role: "operator",
      mustResetPassword: false,
      createdAt: new Date().toISOString(),
    });

    const meetingA = await db.meetings.add({
      scopeUserId: userA,
      subject: "A Meeting",
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const attachmentId = await db.meeting_attachments.add({
      scopeUserId: userA,
      meetingId: meetingA,
      filename: "a.pdf",
      mimeType: "application/pdf",
      size: 8,
      uploader: "userA",
      uploadedAt: new Date().toISOString(),
      contentHash: "h1",
      blobData: new Blob(["A"], { type: "application/pdf" }),
    });

    await dal.saveDeliveryLog({
      notificationId: 1,
      userId: userA,
      eventType: "meeting.materials.distributed",
      status: "delivered",
    }, { bypassAuth: true });

    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: userB,
      username: "userB",
      role: "operator",
    }));
    await expect(dal.getAttachmentBlob(attachmentId)).rejects.toBeInstanceOf(WOGCError);
    await expect(dal.listDeliveryLogs()).rejects.toBeInstanceOf(WOGCError);

    for (const role of ["dispatcher", "facilitator", "auditor"] as const) {
      setDALAuthResolver(() => ({
        isAuthenticated: true,
        userId: userA,
        username: role,
        role,
      }));
      const rows = await dal.listDeliveryLogs();
      expect(rows.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("delivery log page roles: dispatcher/facilitator/auditor allowed, operator/viewer denied", async () => {
    await dal.saveDeliveryLog({
      notificationId: 1,
      userId: 1,
      eventType: "seed",
      status: "delivered",
    }, { bypassAuth: true });

    for (const role of ["dispatcher", "facilitator", "auditor"] as const) {
      setDALAuthResolver(() => ({
        isAuthenticated: true,
        userId: 1,
        username: role,
        role,
      }));
      await expect(dal.listDeliveryLogs()).resolves.toHaveLength(1);
    }

    for (const role of ["operator", "viewer"] as const) {
      setDALAuthResolver(() => ({
        isAuthenticated: true,
        userId: 1,
        username: role,
        role,
      }));
      await expect(dal.listDeliveryLogs()).rejects.toBeInstanceOf(WOGCError);
    }
  });

  it("rolls back domain write when audit append fails", async () => {
    const addSpy = vi.spyOn(db.audit_log, "add").mockRejectedValueOnce(new Error("audit write fail"));

    await expect(dal.saveSystemSetting({ key: "atomic.test", value: "x" })).rejects.toBeInstanceOf(WOGCError);
    const row = await db.system_settings.where("key").equals("atomic.test").first();
    expect(row).toBeUndefined();

    addSpy.mockRestore();
  });
});
