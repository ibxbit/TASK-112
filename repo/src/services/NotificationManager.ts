import { dal } from "../db/dal";
import { WOGCError } from "../utils/errors";

class NotificationManager {
  public isWithinQuietHours(nowDate: Date, quietStart?: string, quietEnd?: string): boolean {
    if (!quietStart || !quietEnd) {
      return false;
    }
    const [startHour, startMinute] = quietStart.split(":").map((part) => Number(part));
    const [endHour, endMinute] = quietEnd.split(":").map((part) => Number(part));
    if ([startHour, startMinute, endHour, endMinute].some((value) => Number.isNaN(value))) {
      return false;
    }

    const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
    const startMinutes = startHour * 60 + startMinute;
    const endMinutes = endHour * 60 + endMinute;

    if (startMinutes === endMinutes) {
      return false;
    }

    if (startMinutes <= endMinutes) {
      return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
    }
    return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
  }

  public async canSendTaskNotification(userId: number, taskId: number): Promise<boolean> {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await dal.listNotifications(300, userId, { bypassAuth: true });
    const count = rows.filter((row) => row.taskId === taskId && row.createdAt.slice(0, 10) === today).length;
    if (count >= 3) {
      return false;
    }
    return true;
  }

  public ensureAttachmentSize(sizeBytes: number): void {
    const fiftyMB = 50 * 1024 * 1024;
    if (sizeBytes > fiftyMB) {
      throw new WOGCError({
        code: "ATTACHMENT_TOO_LARGE",
        message: "Attachment exceeds 50MB limit",
        context: { sizeBytes, limitBytes: fiftyMB },
        retryable: false,
      });
    }
  }
}

export const notificationManager = new NotificationManager();
