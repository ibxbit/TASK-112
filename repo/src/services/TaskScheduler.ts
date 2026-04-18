import { dal } from "../db/dal";
import { store, uiActions } from "../store";
import { ensureWOGCError, WOGCError } from "../utils/errors";
import { eventBus } from "./EventBus";

const SWEEP_INTERVAL_MS = 60_000;

class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  public start(): void {
    if (this.timer) {
      return;
    }

    void this.sweepNow().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.sweepNow().catch(() => undefined);
    }, SWEEP_INTERVAL_MS);
  }

  public stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  public async sweepNow(): Promise<number> {
    try {
      const config = await dal.getPublicConfig();
      const cutoffISO = new Date(Date.now() - config.taskExpiryWindowMs).toISOString();
      const candidates = await dal.getExpirableTasks(cutoffISO);
      const expiredCount = await dal.expireTasks(candidates.map((task) => task.id));

      if (expiredCount > 0) {
        eventBus.publish("tasks.expired", {
          taskIds: candidates.map((task) => task.id),
          expiredAt: new Date().toISOString(),
        });
      }

      return expiredCount;
    } catch (error) {
      const normalized = ensureWOGCError(error, {
        code: "TASK_SWEEP_FAIL",
        message: "Task scheduler sweep failed",
        context: {},
        retryable: true,
      });
      store.dispatch(uiActions.setGlobalError(normalized.toJSON()));
      throw new WOGCError(normalized.toJSON());
    }
  }
}

export const taskScheduler = new TaskScheduler();
