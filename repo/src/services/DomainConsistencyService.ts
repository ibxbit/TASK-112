import { dal } from "../db/dal";
import { eventBus } from "./EventBus";

class DomainConsistencyService {
  private unsubs: Array<() => void> = [];
  private started = false;
  private holdTimers = new Map<number, ReturnType<typeof setTimeout>>();

  private clearHoldTimer(holdId: number): void {
    const existing = this.holdTimers.get(holdId);
    if (existing) {
      clearTimeout(existing);
      this.holdTimers.delete(holdId);
    }
  }

  private scheduleHoldExpiry(holdId: number, expiresAt: string): void {
    this.clearHoldTimer(holdId);
    const dueMs = Math.max(0, Date.parse(expiresAt) - Date.now());
    const timer = setTimeout(() => {
      eventBus.publish("calendar.hold.expired", {
        holdId,
        expiredAt: new Date().toISOString(),
      });
      this.holdTimers.delete(holdId);
    }, dueMs);
    this.holdTimers.set(holdId, timer);
  }

  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.unsubs.push(
      eventBus.subscribe("meeting.resolution.approved", async (event) => {
        const tasks = await dal.listTasks();
        const alreadyExists = tasks.some((task) => task.resolutionId === event.payload.resolutionId);
        if (alreadyExists) {
          return;
        }
        const resolutions = await dal.listResolutions(event.payload.meetingId);
        const resolution = resolutions.find((row) => row.id === event.payload.resolutionId);
        if (!resolution) {
          return;
        }
        await dal.saveTask({
          title: `Resolution: ${resolution.description.slice(0, 80)}`,
          status: "open",
          workstream: "transport",
          resolutionId: event.payload.resolutionId,
          priority: 2,
          assignee: resolution.owner,
          dueDate: resolution.dueDate,
          createdAt: new Date().toISOString(),
        });
      }, { consumerId: "consistency.resolution.approved" }),
    );
    this.unsubs.push(
      eventBus.subscribe("tasks.completed", async (event) => {
        if (!event.payload.resolutionId) {
          return;
        }
        await dal.markResolutionCompleted(event.payload.resolutionId);
      }, { consumerId: "consistency.tasks.completed" }),
    );
    this.unsubs.push(
      eventBus.subscribe("calendar.hold.created", async (event) => {
        await dal.ensureCalendarHoldConsistency({
          holdId: event.payload.holdId,
          resourceId: event.payload.resourceId,
          expiresAt: event.payload.expiresAt,
        });
        this.scheduleHoldExpiry(event.payload.holdId, event.payload.expiresAt);
      }, { consumerId: "consistency.hold.created" }),
    );
    this.unsubs.push(
      eventBus.subscribe("calendar.hold.expired", async (event) => {
        this.clearHoldTimer(event.payload.holdId);
        await dal.reconcileCalendarHoldExpired({
          holdId: event.payload.holdId,
          expiredAt: event.payload.expiredAt,
        });
      }, { consumerId: "consistency.hold.expired" }),
    );
    this.unsubs.push(
      eventBus.subscribe("calendar.hold.converted", async (event) => {
        this.clearHoldTimer(event.payload.holdId);
        await dal.reconcileCalendarHoldConverted({
          holdId: event.payload.holdId,
          taskId: event.payload.taskId,
          convertedAt: event.payload.convertedAt,
        });
      }, { consumerId: "consistency.hold.converted" }),
    );
  }

  public stop(): void {
    this.holdTimers.forEach((timer) => clearTimeout(timer));
    this.holdTimers.clear();
    this.unsubs.forEach((unsub) => unsub());
    this.unsubs = [];
    this.started = false;
  }

  public dlqSnapshot(): Array<{ id: number; eventPayload: { id: string; type: string }; errorContract: { code: string; message: string }; failedAt: string; retryCount: number; status: "pending" | "replayed" | "archived" }> {
    return eventBus.getDLQSnapshot();
  }
}

export const domainConsistencyService = new DomainConsistencyService();
