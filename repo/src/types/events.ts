import type { WOGCErrorInput } from "../utils/errors";

export type WOGCEventType =
  | "equipment.command.requested"
  | "equipment.command.failed"
  | "equipment.heartbeat.generated"
  | "equipment.heartbeat.timeout"
  | "tasks.expired"
  | "tasks.completed"
  | "calendar.hold.created"
  | "calendar.hold.expired"
  | "calendar.hold.converted"
  | "meeting.resolution.approved"
  | "meeting.resolution.completed";

export type EquipmentCommandRequestedPayload = {
  outboxId: number;
  equipmentId: string;
  command: string;
  args: Record<string, unknown>;
};

export type EquipmentCommandFailedPayload = {
  outboxId: number;
  equipmentId: string;
  command: string;
  reason: WOGCErrorInput;
};

export type EquipmentHeartbeatGeneratedPayload = {
  equipmentId: string;
  latencyMs: number;
  observedAt: string;
};

export type EquipmentHeartbeatTimeoutPayload = {
  equipmentId: string;
  lastHeartbeatAt: string;
  timeoutMs: number;
};

export type TasksExpiredPayload = {
  taskIds: number[];
  expiredAt: string;
};

export type TasksCompletedPayload = {
  taskId: number;
  completedAt: string;
  resolutionId?: number;
};

export type CalendarHoldCreatedPayload = {
  holdId: number;
  resourceId?: string;
  expiresAt: string;
};

export type CalendarHoldExpiredPayload = {
  holdId: number;
  expiredAt: string;
};

export type CalendarHoldConvertedPayload = {
  holdId: number;
  taskId: number;
  convertedAt: string;
};

export type MeetingResolutionApprovedPayload = {
  resolutionId: number;
  meetingId: number;
  approvedAt: string;
};

export type MeetingResolutionCompletedPayload = {
  resolutionId: number;
  completedAt: string;
};

export type WOGCEventPayloadMap = {
  "equipment.command.requested": EquipmentCommandRequestedPayload;
  "equipment.command.failed": EquipmentCommandFailedPayload;
  "equipment.heartbeat.generated": EquipmentHeartbeatGeneratedPayload;
  "equipment.heartbeat.timeout": EquipmentHeartbeatTimeoutPayload;
  "tasks.expired": TasksExpiredPayload;
  "tasks.completed": TasksCompletedPayload;
  "calendar.hold.created": CalendarHoldCreatedPayload;
  "calendar.hold.expired": CalendarHoldExpiredPayload;
  "calendar.hold.converted": CalendarHoldConvertedPayload;
  "meeting.resolution.approved": MeetingResolutionApprovedPayload;
  "meeting.resolution.completed": MeetingResolutionCompletedPayload;
};

export type WOGCEventEnvelope<T extends WOGCEventType = WOGCEventType> = {
  id: string;
  type: T;
  payload: WOGCEventPayloadMap[T];
  emittedAt: string;
  retryCount: number;
};
