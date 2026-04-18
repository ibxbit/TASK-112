import { dal } from "../db/dal";
import { ensureWOGCError } from "../utils/errors";
import { eventBus } from "./EventBus";
import { notificationManager } from "./NotificationManager";

const DAILY_TASK_LIMIT = 3;

type Category = "task_assignment" | "equipment_alert" | "meeting_reminder" | "system";

class NotificationService {
  private unsubs: Array<() => void> = [];
  private started = false;
  private dispatchQueue: Promise<void> = Promise.resolve();

  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.unsubs.push(
      eventBus.subscribe("tasks.expired", (event) => this.enqueueDispatch(
        () => this.dispatchToUsers("task_assignment", "tasks.expired", `Tasks expired: ${event.payload.taskIds.join(", ")}`, event.payload.taskIds[0]),
      ), { consumerId: "notification.tasks.expired" }),
    );
    this.unsubs.push(
      eventBus.subscribe("equipment.heartbeat.timeout", (event) => this.enqueueDispatch(
        () => this.dispatchToUsers("equipment_alert", "equipment.heartbeat.timeout", `Heartbeat missed: ${event.payload.equipmentId}`),
      ), { consumerId: "notification.heartbeat.timeout" }),
    );
    this.unsubs.push(
      eventBus.subscribe("equipment.command.failed", (event) => this.enqueueDispatch(
        () => this.dispatchToUsers("equipment_alert", "equipment.command.failed", `Command ${event.payload.command} failed for ${event.payload.equipmentId}`),
      ), { consumerId: "notification.command.failed" }),
    );
  }

  public stop(): void {
    this.unsubs.forEach((unsub) => unsub());
    this.unsubs = [];
    this.dispatchQueue = Promise.resolve();
    this.started = false;
  }

  private enqueueDispatch(task: () => Promise<void>): Promise<void> {
    const run = this.dispatchQueue.then(task);
    this.dispatchQueue = run.catch(() => undefined);
    return run;
  }

  private async dispatchToUsers(category: Category, eventType: string, message: string, taskId?: number): Promise<void> {
    try {
      const config = await dal.getPublicConfig();
      const users = await dal.listUsers({ bypassAuth: true });
      for (const user of users) {
        const subscriptions = await dal.listSubscriptions(user.id, { bypassAuth: true });
        const subscription = subscriptions.find((entry) => entry.category === category);
        const enabled = subscription ? subscription.enabled : true;
        if (!enabled) {
          continue;
        }

        const quietStart = subscription?.quietHoursStart ?? config.quietHoursDefaultStart;
        const quietEnd = subscription?.quietHoursEnd ?? config.quietHoursDefaultEnd;
        if (notificationManager.isWithinQuietHours(new Date(), quietStart, quietEnd)) {
          await dal.saveDeliveryLog({
            notificationId: undefined,
            userId: user.id,
            eventType,
            status: "suppressed_quiet_hours",
            suppressedReason: `Quiet hours ${quietStart}-${quietEnd}`,
          }, { bypassAuth: true });
          continue;
        }

        if (typeof taskId === "number") {
          const canSend = await notificationManager.canSendTaskNotification(user.id, taskId);
          if (!canSend || (config.notificationRateLimitPerDay || DAILY_TASK_LIMIT) < 1) {
            continue;
          }
        }

        const notificationId = await dal.saveNotification({
          userId: user.id,
          category,
          level: category === "equipment_alert" ? "error" : "warn",
          eventType,
          taskId,
          message,
        }, { bypassAuth: true });

        await dal.saveDeliveryLog({
          notificationId,
          userId: user.id,
          eventType,
          status: "delivered",
        }, { bypassAuth: true });
      }
    } catch (error) {
      throw ensureWOGCError(error, {
        code: "NOTIFY_DISPATCH_FAIL",
        message: "Notification dispatch failed",
        context: { category, eventType },
        retryable: true,
      });
    }
  }
}

export const notificationService = new NotificationService();
