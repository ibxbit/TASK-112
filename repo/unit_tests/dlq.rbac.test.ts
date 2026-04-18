import { beforeEach, describe, expect, it } from "vitest";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { db } from "../src/db/schema";
import { dlqService, setDLQCurrentUserResolver } from "../src/services/dlqService";
import { WOGCError } from "../src/utils/errors";

const clearTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

describe("DLQ role governance", () => {
  beforeEach(async () => {
    await clearTables();
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 7,
      username: "auditor",
      role: "auditor",
    }));
    setDLQCurrentUserResolver(() => ({
      userId: 7,
      username: "auditor",
      role: "auditor",
    }));
  });

  it("blocks auditor retryDLQItem with unauthorized error", async () => {
    const id = await dal.saveDLQEntry({
      eventPayload: {
        id: "evt-dlq-rbac",
        type: "tasks.expired",
        payload: { taskIds: [1], expiredAt: new Date().toISOString() },
        emittedAt: new Date().toISOString(),
        retryCount: 0,
      },
      errorContract: {
        code: "EVENT_CONSUMER_FAIL",
        message: "forced",
        retryable: true,
      },
      retryCount: 0,
      status: "pending",
    });

    await expect(dlqService.retryDLQItem(id)).rejects.toBeInstanceOf(WOGCError);
    await expect(dlqService.retryDLQItem(id)).rejects.toMatchObject({ code: "AUTH_403" });
  });

  it("enforces admin-only DAL mutation message on retry", async () => {
    const id = await dal.saveDLQEntry({
      eventPayload: {
        id: "evt-dlq-admin-only",
        type: "tasks.expired",
        payload: { taskIds: [2], expiredAt: new Date().toISOString() },
        emittedAt: new Date().toISOString(),
        retryCount: 0,
      },
      errorContract: {
        code: "EVENT_CONSUMER_FAIL",
        message: "forced",
        retryable: true,
      },
      retryCount: 0,
      status: "pending",
    });

    await expect(dal.retryDLQItem(id, "dispatcher")).rejects.toThrow(
      "DAL Unauthorized: Only Administrators can mutate DLQ status",
    );
  });
});
