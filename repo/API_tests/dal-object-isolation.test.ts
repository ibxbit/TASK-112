import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/schema";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { WOGCError } from "../src/utils/errors";

const clearTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

describe("cross-user DAL access denial", () => {
  beforeEach(async () => {
    await clearTables();
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 1,
      username: "administrator",
      role: "administrator",
    }));
  });

  it("enforces object-level isolation for notifications and meeting attachments", async () => {
    const userA = await db.users.add({
      username: "userA",
      displayName: "User A",
      badgeId: "A-1001",
      passwordHash: "x",
      salt: "y",
      iterations: 120000,
      role: "operator",
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

    await dal.saveNotification({
      userId: userA,
      category: "system",
      message: "A-only",
      eventType: "seed",
      level: "info",
    }, { bypassAuth: true });
    await dal.saveNotification({
      userId: userB,
      category: "system",
      message: "B-only",
      eventType: "seed",
      level: "info",
    }, { bypassAuth: true });

    const meetingA = await db.meetings.add({
      scopeUserId: userA,
      subject: "A mtg",
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 10_000).toISOString(),
    });
    const meetingB = await db.meetings.add({
      scopeUserId: userB,
      subject: "B mtg",
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 10_000).toISOString(),
    });
    await db.meeting_attachments.add({
      scopeUserId: userA,
      meetingId: meetingA,
      filename: "a.pdf",
      mimeType: "application/pdf",
      size: 2,
      uploader: "userA",
      uploadedAt: new Date().toISOString(),
      contentHash: "a",
      blobData: new Blob(["a"], { type: "application/pdf" }),
    });
    await db.meeting_attachments.add({
      scopeUserId: userB,
      meetingId: meetingB,
      filename: "b.pdf",
      mimeType: "application/pdf",
      size: 2,
      uploader: "userB",
      uploadedAt: new Date().toISOString(),
      contentHash: "b",
      blobData: new Blob(["b"], { type: "application/pdf" }),
    });

    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: userA,
      username: "userA",
      role: "facilitator",
    }));

    const ownNotifications = await dal.listNotifications(50, userA);
    expect(ownNotifications).toHaveLength(1);
    expect(ownNotifications[0]?.message).toBe("A-only");

    await expect(dal.listNotifications(50, userB)).rejects.toBeInstanceOf(WOGCError);

    const foreignMeetingAttachments = await dal.listAttachments(meetingB);
    expect(foreignMeetingAttachments).toHaveLength(0);

    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 99,
      username: "auditor",
      role: "auditor",
    }));
    const allNotificationsAuditor = await dal.listNotifications(50);
    expect(allNotificationsAuditor.length).toBeGreaterThanOrEqual(2);
    const auditViewMeetingB = await dal.listAttachments(meetingB);
    expect(auditViewMeetingB).toHaveLength(1);

    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: userA,
      username: "userA",
      role: "operator",
    }));
    await expect(dal.listDLQEntries()).rejects.toBeInstanceOf(WOGCError);
  });
});
