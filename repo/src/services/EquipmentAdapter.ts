import { dal } from "../db/dal";
import { store, uiActions } from "../store";
import { ensureWOGCError, WOGCError } from "../utils/errors";
import { eventBus } from "./EventBus";
import type { EquipmentCommandRequestedPayload } from "../types/events";

const OUTBOX_POLL_MS = 2_000;
const HEARTBEAT_CHECK_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 20_000;
const EQUIP_COMMAND_MAX_RETRIES = 3;
const EQUIP_COMMAND_BACKOFF_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class EquipmentAdapter {
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeCommand: (() => void) | null = null;
  private readonly lastHeartbeatByEquipment = new Map<string, number>();
  private readonly outboxLocks = new Map<number, number>();

  public start(): void {
    if (!this.unsubscribeCommand) {
      this.unsubscribeCommand = eventBus.subscribe("equipment.command.requested", async (event) => {
        await this.handleEquipmentCommand(event.payload);
      });
    }

    if (!this.outboxTimer) {
      void this.flushOutbox().catch(() => undefined);
      this.outboxTimer = setInterval(() => {
        void this.flushOutbox().catch(() => undefined);
      }, OUTBOX_POLL_MS);
    }

    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        void this.monitorHeartbeatTimeouts().catch(() => undefined);
      }, HEARTBEAT_CHECK_MS);
    }
  }

  public stop(): void {
    if (this.unsubscribeCommand) {
      this.unsubscribeCommand();
      this.unsubscribeCommand = null;
    }
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  public registerHeartbeatForMonitoring(equipmentId: string, atMs = Date.now()): void {
    this.lastHeartbeatByEquipment.set(equipmentId, atMs);
  }

  public async checkHeartbeatTimeoutsNow(): Promise<void> {
    await this.monitorHeartbeatTimeouts();
  }

  private async flushOutbox(): Promise<void> {
    try {
      const nowMs = Date.now();

      const rows = await dal.getPendingOutbox(25);
      for (const row of rows) {
        if (row.retryCount >= EQUIP_COMMAND_MAX_RETRIES) {
          await dal.deleteOutboxMessage(row.id, "dispatcher");
          eventBus.publish("equipment.command.failed", {
            outboxId: row.id,
            equipmentId: typeof row.payload.equipmentId === "string" ? row.payload.equipmentId : "",
            command: typeof row.payload.command === "string" ? row.payload.command : "",
            reason: {
              code: "EQUIP_FAIL",
              message: "Equipment command exceeded retry budget",
              context: { outboxId: row.id, retries: row.retryCount },
              retryable: false,
            },
          });
          continue;
        }

        const nextAttemptAt = this.outboxLocks.get(row.id);
        if (typeof nextAttemptAt === "number" && nextAttemptAt > nowMs) {
          continue;
        }

        const equipmentId = typeof row.payload.equipmentId === "string" ? row.payload.equipmentId : "";
        const command = typeof row.payload.command === "string" ? row.payload.command : "";
        const args =
          typeof row.payload.args === "object" && row.payload.args !== null
            ? (row.payload.args as Record<string, unknown>)
            : {};

        this.outboxLocks.set(row.id, Date.now() + EQUIP_COMMAND_BACKOFF_MS);
        eventBus.publish("equipment.command.requested", {
          outboxId: row.id,
          equipmentId,
          command,
          args,
        });
      }
    } catch (error) {
      const normalized = ensureWOGCError(error, {
        code: "OUTBOX_FLUSH_FAIL",
        message: "Failed to flush equipment outbox",
        context: {},
        retryable: true,
      });
      store.dispatch(uiActions.setGlobalError(normalized.toJSON()));
      throw new WOGCError(normalized.toJSON());
    }
  }

  private async handleEquipmentCommand(payload: EquipmentCommandRequestedPayload): Promise<void> {
    if (!payload.equipmentId || !payload.command) {
      this.outboxLocks.delete(payload.outboxId);
      eventBus.publish("equipment.command.failed", {
        outboxId: payload.outboxId,
        equipmentId: payload.equipmentId,
        command: payload.command,
        reason: {
          code: "EQUIP_BAD_CMD",
          message: "Equipment command is malformed",
          context: { outboxId: payload.outboxId, payload },
          retryable: false,
        },
      });
      return;
    }

    try {
      const latencyMs = 200 + Math.floor(Math.random() * 700);
      await sleep(latencyMs);

      if (Math.random() < 0.2) {
        throw new WOGCError({
          code: "EQUIP_FAIL",
          message: "Equipment command failed",
          context: {
            outboxId: payload.outboxId,
            equipmentId: payload.equipmentId,
            command: payload.command,
          },
          retryable: true,
        });
      }

      const observedAt = new Date().toISOString();
      await dal.recordHeartbeat({
        equipmentId: payload.equipmentId,
        status: "ok",
        latencyMs,
        observedAt,
      });
      await dal.deleteOutboxMessage(payload.outboxId, "dispatcher");
      this.lastHeartbeatByEquipment.set(payload.equipmentId, Date.now());
      this.outboxLocks.delete(payload.outboxId);

      eventBus.publish("equipment.heartbeat.generated", {
        equipmentId: payload.equipmentId,
        latencyMs,
        observedAt,
      });
    } catch (error) {
      const normalized = ensureWOGCError(error, {
        code: "EQUIP_FAIL",
        message: "Equipment command failed",
        context: { outboxId: payload.outboxId, equipmentId: payload.equipmentId },
        retryable: true,
      });

      await dal.bumpOutboxRetry(payload.outboxId, "dispatcher");
      eventBus.publish("equipment.command.failed", {
        outboxId: payload.outboxId,
        equipmentId: payload.equipmentId,
        command: payload.command,
        reason: normalized.toJSON(),
      });
      this.outboxLocks.set(payload.outboxId, Date.now() + EQUIP_COMMAND_BACKOFF_MS);
    }
  }

  private async monitorHeartbeatTimeouts(): Promise<void> {
    try {
      const nowMs = Date.now();
      const config = await dal.getPublicConfig();
      const timeoutMs = config.heartbeatTimeoutMs;
      for (const [equipmentId, lastHeartbeatAt] of this.lastHeartbeatByEquipment.entries()) {
        if (nowMs - lastHeartbeatAt <= timeoutMs) {
          continue;
        }

        const observedAt = new Date(nowMs).toISOString();
        await dal.recordHeartbeat({
          equipmentId,
          status: "timeout",
          latencyMs: timeoutMs,
          observedAt,
        });

        eventBus.publish("equipment.heartbeat.timeout", {
          equipmentId,
          lastHeartbeatAt: new Date(lastHeartbeatAt).toISOString(),
          timeoutMs,
        });

        this.lastHeartbeatByEquipment.set(equipmentId, nowMs);
      }
    } catch (error) {
      const normalized = ensureWOGCError(error, {
        code: "HEARTBEAT_MONITOR_FAIL",
        message: "Failed to monitor heartbeats",
        context: {},
        retryable: true,
      });
      store.dispatch(uiActions.setGlobalError(normalized.toJSON()));
      throw new WOGCError(normalized.toJSON());
    }
  }
}

export const equipmentAdapter = new EquipmentAdapter();
