import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/schema";
import { eventBus } from "../src/services/EventBus";
import { taskScheduler } from "../src/services/TaskScheduler";
import { equipmentAdapter } from "../src/services/EquipmentAdapter";
import { setDALEventPublisher, setDALAuthResolver } from "../src/db/dal";
import { dal } from "../src/db/dal";
import { domainConsistencyService } from "../src/services/DomainConsistencyService";
import { store } from "../src/store";
import { logout } from "../src/store/authSlice";
import { WOGCError } from "../src/utils/errors";

const clearTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

const waitFor = async (check: () => boolean, timeoutMs = 1000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
};

const waitForAsync = async (check: () => Promise<boolean>, timeoutMs = 1000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
};

describe("service integration flows", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    store.dispatch(logout());
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 1,
      username: "dispatcher",
      role: "dispatcher",
    }));
    setDALEventPublisher((type, payload) => {
      eventBus.publish(type, payload);
    });
    domainConsistencyService.stop();
    await eventBus.clearProcessedRegistry();
    await clearTables();
  });

  it("emits tasks.expired from scheduler sweep", async () => {
    const getExpirableSpy = vi.spyOn(dal, "getExpirableTasks").mockResolvedValue([
      {
        id: 99,
        title: "Old task",
        status: "open",
        workstream: "putaway",
        priority: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    const expireSpy = vi.spyOn(dal, "expireTasks").mockResolvedValue(1);

    let eventCount = 0;
    const unsub = eventBus.subscribe("tasks.expired", () => {
      eventCount += 1;
    });

    const count = await taskScheduler.sweepNow();
    await waitFor(() => eventCount >= 1);

    expect(count).toBe(1);
    expect(eventCount).toBe(1);
    unsub();
    getExpirableSpy.mockRestore();
    expireSpy.mockRestore();
  });

  it("emits heartbeat timeout events when missed", async () => {
    const recordHeartbeatSpy = vi.spyOn(dal, "recordHeartbeat").mockResolvedValue(1);
    let timeoutEvents = 0;
    const unsub = eventBus.subscribe("equipment.heartbeat.timeout", () => {
      timeoutEvents += 1;
    });

    equipmentAdapter.registerHeartbeatForMonitoring("AGV-X", Date.now() - 25_000);
    await equipmentAdapter.checkHeartbeatTimeoutsNow();
    await waitFor(() => timeoutEvents >= 1);

    expect(timeoutEvents).toBeGreaterThanOrEqual(1);
    unsub();
    recordHeartbeatSpy.mockRestore();
  });

  it("calendar hold created retries transient failures and stays idempotent on replay", async () => {
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 1,
      username: "administrator",
      role: "administrator",
    }));
    domainConsistencyService.start();

    const holdId = await db.calendar_holds.add({
      workspaceId: "default",
      title: "Hold A",
      resourceId: "ZONE-A",
      startAt: new Date(Date.now() + 1_000).toISOString(),
      endAt: new Date(Date.now() + 5_000).toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: "active",
      createdAt: new Date().toISOString(),
    });

    let attempts = 0;
    const unsubRetryProbe = eventBus.subscribe("calendar.hold.created", () => {
      attempts += 1;
      if (attempts === 1) {
        throw new WOGCError({
          code: "HOLD_RETRY",
          message: "transient calendar hold consumer fault",
          context: { holdId },
          retryable: true,
        });
      }
    }, { consumerId: "test.hold.retry-probe" });

    const eventId = "evt-hold-created-1";
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    eventBus.publish("calendar.hold.created", { holdId, resourceId: "ZONE-A", expiresAt }, { eventId });
    eventBus.publish("calendar.hold.created", { holdId, resourceId: "ZONE-A", expiresAt }, { eventId });
    await waitFor(() => attempts >= 2, 1500);
    await waitForAsync(async () => {
      const blocks = (await db.calendar_events.toArray()).filter((row) => row.category === "holds" && row.title === `hold:${holdId}`);
      return blocks.length === 1;
    }, 1500);

    const blocks = (await db.calendar_events.toArray()).filter((row) => row.category === "holds" && row.title === `hold:${holdId}`);
    const caps = await db.calendar_capacities.where("workspaceId").equals(`hold:${holdId}`).toArray();
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(blocks).toHaveLength(1);
    expect(caps).toHaveLength(1);
    unsubRetryProbe();
    domainConsistencyService.stop();
  });

  it("routes calendar hold conversion failures to DLQ and does not mutate state", async () => {
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 1,
      username: "administrator",
      role: "administrator",
    }));
    domainConsistencyService.start();

    const holdId = await db.calendar_holds.add({
      workspaceId: "default",
      title: "Hold B",
      resourceId: "ZONE-B",
      startAt: new Date(Date.now() + 1_000).toISOString(),
      endAt: new Date(Date.now() + 5_000).toISOString(),
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
      status: "active",
      createdAt: new Date().toISOString(),
    });
    await dal.ensureCalendarHoldConsistency({ holdId, resourceId: "ZONE-B", expiresAt: new Date(Date.now() + 20_000).toISOString() });

    const baseline = eventBus.getDLQSnapshot().length;
    eventBus.publish("calendar.hold.converted", {
      holdId,
      taskId: 999_001,
      convertedAt: new Date().toISOString(),
    });

    await waitFor(() => eventBus.getDLQSnapshot().length > baseline);

    const dlq = eventBus.getDLQSnapshot();
    const latest = dlq[dlq.length - 1];
    expect(latest.errorContract.code).toBe("TASK_404");
    expect(latest.errorContract.retryable).toBe(false);
    const blocks = (await db.calendar_events.toArray()).filter((row) => row.category === "holds" && row.title === `hold:${holdId}`);
    expect(blocks).toHaveLength(1);
    domainConsistencyService.stop();
  });
});
