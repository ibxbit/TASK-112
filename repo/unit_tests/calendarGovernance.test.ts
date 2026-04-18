import { beforeEach, describe, expect, it } from "vitest";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { db } from "../src/db/schema";
import { WOGCError } from "../src/utils/errors";

const clearTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

describe("calendar governance", () => {
  beforeEach(async () => {
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 1,
      username: "administrator",
      role: "administrator",
    }));
    await clearTables();
  });

  it("blocks event creation when capacity is exceeded", async () => {
    const now = new Date();
    const inHour = new Date(now.getTime() + 60 * 60 * 1000);
    await dal.saveCalendarCapacity({
      resourceId: "ZONE-A",
      slotStart: now.toISOString(),
      slotEnd: inHour.toISOString(),
      maxOccupancy: 1,
    });
    await dal.saveCalendarEvent({
      title: "existing",
      eventType: "meeting",
      recurrenceRule: "none",
      category: "occupancy",
      resourceId: "ZONE-A",
      startAt: now.toISOString(),
      endAt: inHour.toISOString(),
    });

    let err: unknown = null;
    try {
      await dal.saveCalendarEvent({
        title: "second",
        eventType: "meeting",
        recurrenceRule: "none",
        category: "occupancy",
        resourceId: "ZONE-A",
        startAt: now.toISOString(),
        endAt: inHour.toISOString(),
      });
    } catch (error) {
      err = error;
    }
    expect(err instanceof WOGCError).toBe(true);
    expect((err as WOGCError).code).toBe("CAPACITY_CONFLICT");
  });

  it("blocks task assignment during active lockout", async () => {
    const taskId = await dal.saveTask({
      title: "Assign me",
      status: "open",
      resourceId: "AGV-2",
      createdAt: new Date().toISOString(),
    });
    await dal.saveCalendarLockout({
      resourceId: "AGV-2",
      reason: "maintenance",
      startAt: new Date(Date.now() - 1000).toISOString(),
      endAt: new Date(Date.now() + 60_000).toISOString(),
    });

    let err: unknown = null;
    try {
      await dal.saveTask({
        id: taskId,
        title: "Assign me",
        status: "open",
        resourceId: "AGV-2",
        assignee: "ops-a",
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      err = error;
    }
    expect(err instanceof WOGCError).toBe(true);
    expect((err as WOGCError).code).toBe("DB_WRITE_FAIL");
  });
});
