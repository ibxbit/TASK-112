import { eventBusActions, store } from "../store";
import { db } from "../db/schema";
import { dal } from "../db/dal";
import {
  ensureWOGCError,
  WOGCError,
  type WOGCErrorInput,
} from "../utils/errors";
import type {
  WOGCEventEnvelope,
  WOGCEventPayloadMap,
  WOGCEventType,
} from "../types/events";
import { dlqService } from "./dlqService";

type EventConsumer<T extends WOGCEventType> = (event: WOGCEventEnvelope<T>) => Promise<void> | void;

type SubscriptionOptions = {
  consumerId?: string;
};

type EventSubscriberMap = {
  [K in WOGCEventType]: Set<{ id: string; fn: EventConsumer<K> }>;
};

const MAX_RETRIES = 5;
const EQUIPMENT_COMMAND_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const EQUIPMENT_COMMAND_BACKOFF_MS = 10_000;
const MAX_PROCESSED_RECORDS = 5000;

const createEventId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

class EventBus {
  private readonly subscribers: EventSubscriberMap = {
    "equipment.command.requested": new Set(),
    "equipment.command.failed": new Set(),
    "equipment.heartbeat.generated": new Set(),
    "equipment.heartbeat.timeout": new Set(),
    "tasks.expired": new Set(),
    "tasks.completed": new Set(),
    "calendar.hold.created": new Set(),
    "calendar.hold.expired": new Set(),
    "calendar.hold.converted": new Set(),
    "meeting.resolution.approved": new Set(),
    "meeting.resolution.completed": new Set(),
  };

  private consumerSeq = 0;
  private inFlight = new Set<string>();
  private degraded = false;
  private degradedReason: string | null = null;

  private createConsumerId(prefix: string): string {
    this.consumerSeq += 1;
    return `${prefix}:${this.consumerSeq}`;
  }

  private processingKey(consumerId: string, eventId: string): string {
    return `${consumerId}:${eventId}`;
  }

  private async alreadyProcessed(consumerId: string, event: WOGCEventEnvelope): Promise<boolean> {
    const consumerKey = this.processingKey(consumerId, event.id);
    const row = await db.event_processing.where("consumerKey").equals(consumerKey).first();
    return Boolean(row);
  }

  private async markProcessed(consumerId: string, event: WOGCEventEnvelope): Promise<void> {
    const consumerKey = this.processingKey(consumerId, event.id);
    await db.event_processing.put({
      consumerKey,
      eventType: event.type,
      processedAt: new Date().toISOString(),
    });
    const total = await db.event_processing.count();
    if (total > MAX_PROCESSED_RECORDS) {
      const overflow = total - MAX_PROCESSED_RECORDS;
      const stale = await db.event_processing.orderBy("processedAt").limit(overflow).toArray();
      for (const row of stale) {
        if (typeof row.id === "number") {
          await db.event_processing.delete(row.id);
        }
      }
    }
  }

  public async clearProcessedRegistry(): Promise<void> {
    await db.event_processing.clear();
  }

  public subscribe<T extends WOGCEventType>(
    type: T,
    consumer: EventConsumer<T>,
    options?: SubscriptionOptions,
  ): () => void {
    const typedSet = this.subscribers[type] as Set<{ id: string; fn: EventConsumer<T> }>;
    const id = options?.consumerId ?? this.createConsumerId(type);
    const entry = { id, fn: consumer };
    typedSet.add(entry);
    return () => {
      typedSet.delete(entry);
    };
  }

  public publish<T extends WOGCEventType>(
    type: T,
    payload: WOGCEventPayloadMap[T],
    options?: { eventId?: string },
  ): string {
    const envelope: WOGCEventEnvelope<T> = {
      id: options?.eventId ?? createEventId(),
      type,
      payload,
      emittedAt: new Date().toISOString(),
      retryCount: 0,
    };
    if (this.degraded) {
      return envelope.id;
    }
    void this.dispatch(envelope);
    return envelope.id;
  }

  public async publishEnvelope<T extends WOGCEventType>(event: WOGCEventEnvelope<T>): Promise<void> {
    if (this.degraded) {
      return;
    }
    await this.dispatch(event);
  }

  private async dispatch<T extends WOGCEventType>(event: WOGCEventEnvelope<T>): Promise<void> {
    const consumers = this.subscribers[event.type] as Set<{ id: string; fn: EventConsumer<T> }>;
    if (consumers.size === 0) {
      return;
    }

    for (const consumer of consumers) {
      try {
        const key = this.processingKey(consumer.id, event.id);
        if (this.inFlight.has(key)) {
          continue;
        }
        this.inFlight.add(key);
        const seen = await this.alreadyProcessed(consumer.id, event);
        if (seen) {
          this.inFlight.delete(key);
          continue;
        }
        await consumer.fn(event);
        await this.markProcessed(consumer.id, event);
        this.inFlight.delete(key);
      } catch (error) {
        if (error instanceof DOMException && error.name === "QuotaExceededError") {
          this.pauseDegraded("QuotaExceededError");
          return;
        }
        this.inFlight.delete(this.processingKey(consumer.id, event.id));
        const normalized = ensureWOGCError(error, {
          code: "EVENT_CONSUMER_FAIL",
          message: "Event consumer failed",
          context: { eventId: event.id, eventType: event.type },
          retryable: true,
        }).toJSON();
        this.handleConsumerFailure(event, normalized);
      }
    }
  }

  private handleConsumerFailure<T extends WOGCEventType>(
    event: WOGCEventEnvelope<T>,
    error: WOGCErrorInput,
  ): void {
    const isEquipmentCommand = event.type === "equipment.command.requested";
    const maxRetries = isEquipmentCommand ? EQUIPMENT_COMMAND_MAX_RETRIES : MAX_RETRIES;
    if (!error.retryable) {
      this.pushToDLQ(event, error);
      return;
    }

    if (event.retryCount >= maxRetries) {
      this.pushToDLQ(event, {
        ...error,
        code: "EVENT_MAX_RETRIES",
        message: `Exceeded max retries (${maxRetries}) for ${event.type}`,
        retryable: false,
      });
      return;
    }

    const nextRetry = event.retryCount + 1;
    const backoffMs = isEquipmentCommand ? EQUIPMENT_COMMAND_BACKOFF_MS : BASE_BACKOFF_MS * 2 ** (nextRetry - 1);
    const retryEnvelope: WOGCEventEnvelope<T> = {
      ...event,
      retryCount: nextRetry,
    };

    setTimeout(() => {
      void this.dispatch(retryEnvelope);
    }, backoffMs);
  }

  private pushToDLQ<T extends WOGCEventType>(event: WOGCEventEnvelope<T>, reason: WOGCErrorInput): void {
    void dal.saveDLQEntry({
      eventPayload: event,
      errorContract: {
        code: reason.code,
        message: reason.message,
        context: reason.context,
        retryable: reason.retryable,
      },
      retryCount: event.retryCount,
      status: "pending",
    }).then(async () => {
      const rows = await dal.listDLQEntries("pending");
      store.dispatch(eventBusActions.setDLQ(rows.map((row) => ({
        id: row.id,
        eventPayload: row.eventPayload,
        errorContract: row.errorContract,
        failedAt: row.failedAt,
        retryCount: row.retryCount,
        status: row.status,
      }))));
    }).catch(async () => {
      try {
        const authBypassRowId = await db.dead_letter_queue.add({
          eventPayload: event,
          errorContract: {
            code: reason.code,
            message: reason.message,
            context: reason.context ?? {},
            retryable: reason.retryable,
          },
          failedAt: new Date().toISOString(),
          retryCount: event.retryCount,
          status: "pending",
        });
        const row = await db.dead_letter_queue.get(authBypassRowId);
        if (row && typeof row.id === "number") {
          const snapshot = store.getState().eventBus.deadLetterQueue;
          store.dispatch(eventBusActions.setDLQ([
            {
              id: row.id,
              eventPayload: row.eventPayload,
              errorContract: row.errorContract,
              failedAt: row.failedAt,
              retryCount: row.retryCount,
              status: row.status,
            },
            ...snapshot,
          ]));
        }
      } catch (fallbackError) {
        if (fallbackError instanceof DOMException && fallbackError.name === "QuotaExceededError") {
          this.pauseDegraded("QuotaExceededError");
        }
        return;
      }
    });
  }

  private pauseDegraded(reason: string): void {
    this.degraded = true;
    this.degradedReason = reason;
  }

  public getBusHealth(): { paused: boolean; reason: string | null } {
    return {
      paused: this.degraded,
      reason: this.degradedReason,
    };
  }

  public resumeBus(): void {
    this.degraded = false;
    this.degradedReason = null;
  }

  public async hydrateDLQView(): Promise<void> {
    try {
      const rows = await dal.listDLQEntries();
      store.dispatch(eventBusActions.setDLQ(rows.map((row) => ({
        id: row.id,
        eventPayload: row.eventPayload,
        errorContract: row.errorContract,
        failedAt: row.failedAt,
        retryCount: row.retryCount,
        status: row.status,
      }))));
    } catch {
      store.dispatch(eventBusActions.setDLQ([]));
    }
  }

  public async retryDLQEvent(dlqId: number): Promise<void> {
    const row = await dlqService.getById(dlqId);
    if (!row) {
      return;
    }
    const error = row.errorContract;
    if (!error || typeof error.code !== "string" || typeof error.message !== "string" || typeof error.retryable !== "boolean") {
      throw new WOGCError({
        code: "DLQ_INVALID_ERROR_CONTRACT",
        message: "Invalid DLQ error contract payload",
        context: { dlqId },
        retryable: false,
      });
    }
    if (typeof row.eventPayload?.type !== "string" || typeof row.eventPayload?.id !== "string") {
      throw new WOGCError({
        code: "DLQ_INVALID_EVENT_PAYLOAD",
        message: "Invalid DLQ event payload",
        context: { dlqId },
        retryable: false,
      });
    }
    await dlqService.retryDLQItem(dlqId);
    const replayEnvelope = {
      ...row.eventPayload,
      retryCount: row.retryCount,
    } as WOGCEventEnvelope;
    await this.publishEnvelope(replayEnvelope);
    await this.hydrateDLQView();
  }

  public async archiveDLQEvent(dlqId: number): Promise<void> {
    await dlqService.archiveDLQItem(dlqId);
    await this.hydrateDLQView();
  }

  public getDLQSnapshot(): Array<{ id: number; eventPayload: WOGCEventEnvelope; errorContract: WOGCErrorInput; failedAt: string; retryCount: number; status: "pending" | "replayed" | "archived" }> {
    return store.getState().eventBus.deadLetterQueue;
  }
}

export const eventBus = new EventBus();
