import Dexie, { type Table } from "dexie";
import type { WOGCErrorInput } from "../utils/errors";
import type { WOGCEventEnvelope } from "../types/events";

export type UserRole = "administrator" | "dispatcher" | "facilitator" | "operator" | "viewer" | "auditor";
export type TaskWorkstream = "putaway" | "transport" | "picking" | "replenishment";

export interface UserRecord {
  id?: number;
  username: string;
  displayName?: string;
  badgeId: string;
  passwordHash: string;
  salt: string;
  iterations: number;
  role: UserRole;
  mustResetPassword?: boolean;
  createdAt: string;
}

export type UserProfileRecord = Omit<UserRecord, "passwordHash" | "salt" | "iterations">;

export interface TaskRecord {
  id?: number;
  scopeUserId?: number;
  title: string;
  description?: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  status: "open" | "in_progress" | "done" | "expired";
  workstream: TaskWorkstream;
  resourceId?: string;
  resolutionId?: number;
  assignee?: string;
  dueDate?: string;
  acknowledgedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EquipmentHeartbeatRecord {
  id?: number;
  scopeUserId?: number;
  equipmentId: string;
  equipmentSerial?: string;
  status: "ok" | "timeout";
  latencyMs: number;
  observedAt: string;
}

export interface CalendarEventRecord {
  id?: number;
  scopeUserId?: number;
  title: string;
  eventType?: "task" | "maintenance" | "meeting" | "shift";
  category?: "occupancy" | "holds" | "maintenance";
  resourceId?: string;
  recurrenceRule?: "none" | "daily" | "weekly" | "monthly";
  startAt: string;
  endAt: string;
}

export interface CalendarCapacityRecord {
  id?: number;
  workspaceId?: string;
  resourceId?: string;
  slotStart: string;
  slotEnd: string;
  maxOccupancy: number;
  createdAt: string;
}

export interface CalendarLockoutRecord {
  id?: number;
  workspaceId?: string;
  resourceId?: string;
  reason: string;
  startAt: string;
  endAt: string;
  createdAt: string;
}

export interface CalendarHoldRecord {
  id?: number;
  workspaceId?: string;
  resourceId?: string;
  title: string;
  startAt: string;
  endAt: string;
  expiresAt: string;
  status: "active" | "converted" | "expired";
  createdAt: string;
}

export interface MeetingRecord {
  id?: number;
  scopeUserId?: number;
  subject: string;
  facilitator?: string;
  minutes?: string;
  signIn?: string[];
  startAt: string;
  endAt: string;
}

export interface MeetingAgendaItemRecord {
  id?: number;
  scopeUserId?: number;
  meetingId: number;
  title: string;
  description?: string;
  owner?: string;
  durationMinutes: number;
  orderIndex: number;
  status: "pending" | "in_progress" | "completed";
  spentMinutes?: number;
  createdAt: string;
}

export interface MeetingResolutionRecord {
  id?: number;
  scopeUserId?: number;
  meetingId: number;
  description: string;
  proposer: string;
  voteOutcome?: "approved" | "rejected" | "abstained";
  owner?: string;
  dueDate?: string;
  approved: boolean;
  createdAt: string;
}

export interface MeetingAttachmentRecord {
  id?: number;
  scopeUserId?: number;
  meetingId: number;
  filename: string;
  mimeType: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  size: number;
  uploader: string;
  uploadedAt: string;
  contentHash: string;
  blobData?: Blob;
}

export interface NotificationRecord {
  id?: number;
  workspaceId?: string;
  userId: number;
  channel: "ui";
  category: "task_assignment" | "equipment_alert" | "meeting_reminder" | "system";
  level?: "info" | "warn" | "error";
  eventType?: string;
  taskId?: number;
  message: string;
  createdAt: string;
}

export interface UserSubscriptionRecord {
  id?: number;
  workspaceId?: string;
  userId: number;
  category: NotificationRecord["category"];
  enabled: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  updatedAt: string;
}

export interface NotificationReadReceiptRecord {
  id?: number;
  workspaceId?: string;
  notificationId: number;
  userId: number;
  viewedAt: string;
}

export interface NotificationDeliveryLogRecord {
  id?: number;
  workspaceId?: string;
  notificationId?: number;
  userId: number;
  eventType: string;
  deliveredAt: string;
  status: "delivered" | "suppressed_quiet_hours";
  suppressedReason?: string;
  read: boolean;
  readAt?: string;
}

export interface AuditLogRecord {
  id?: number;
  sequence: number;
  hash: string;
  action: string;
  entity: string;
  entityId: string;
  actorRole: UserRole | "anonymous";
  actorUserId?: number;
  actorUsername?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  details: Record<string, unknown>;
  timestamp: string;
}

export interface SessionRecord {
  id?: number;
  userId: number;
  username: string;
  role: UserRole;
  createdAt: string;
  lastSeenAt: string;
  terminatedAt?: string;
}

export interface SystemSettingRecord {
  id?: number;
  key: string;
  value: string;
  updatedAt: string;
}

export interface PermissionOverrideRecord {
  id?: number;
  role: UserRole;
  scope: string;
  canRead: boolean;
  canWrite: boolean;
  updatedAt: string;
}

export interface WarehouseSiteRecord {
  id?: number;
  code: string;
  name: string;
  timezone: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EquipmentAdapterRecord {
  id?: number;
  adapterKey: string;
  displayName: string;
  protocol: "opcua" | "mqtt" | "rest" | "file";
  endpoint: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OperationalTemplateRecord {
  id?: number;
  templateKey: string;
  name: string;
  workstream: TaskWorkstream;
  content: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MessageOutboxRecord {
  id?: number;
  topic: string;
  payload: Record<string, unknown>;
  retryCount: number;
  createdAt: string;
}

export interface EventProcessingRecord {
  id?: number;
  consumerKey: string;
  eventType: string;
  processedAt: string;
}

export interface DeadLetterQueueRecord {
  id?: number;
  eventPayload: WOGCEventEnvelope;
  errorContract: WOGCErrorInput;
  failedAt: string;
  retryCount: number;
  status: "pending" | "replayed" | "archived";
}

class WOGCDatabase extends Dexie {
  public users!: Table<UserRecord, number>;
  public tasks!: Table<TaskRecord, number>;
  public equipment_heartbeats!: Table<EquipmentHeartbeatRecord, number>;
  public calendar_events!: Table<CalendarEventRecord, number>;
  public calendar_capacities!: Table<CalendarCapacityRecord, number>;
  public calendar_lockouts!: Table<CalendarLockoutRecord, number>;
  public calendar_holds!: Table<CalendarHoldRecord, number>;
  public meetings!: Table<MeetingRecord, number>;
  public notifications!: Table<NotificationRecord, number>;
  public user_subscriptions!: Table<UserSubscriptionRecord, number>;
  public notification_read_receipts!: Table<NotificationReadReceiptRecord, number>;
  public notification_delivery_logs!: Table<NotificationDeliveryLogRecord, number>;
  public audit_log!: Table<AuditLogRecord, number>;
  public message_outbox!: Table<MessageOutboxRecord, number>;
  public meeting_agenda_items!: Table<MeetingAgendaItemRecord, number>;
  public meeting_resolutions!: Table<MeetingResolutionRecord, number>;
  public meeting_attachments!: Table<MeetingAttachmentRecord, number>;
  public sessions!: Table<SessionRecord, number>;
  public system_settings!: Table<SystemSettingRecord, number>;
  public permission_overrides!: Table<PermissionOverrideRecord, number>;
  public warehouse_sites!: Table<WarehouseSiteRecord, number>;
  public equipment_adapters!: Table<EquipmentAdapterRecord, number>;
  public operational_templates!: Table<OperationalTemplateRecord, number>;
  public event_processing!: Table<EventProcessingRecord, number>;
  public dead_letter_queue!: Table<DeadLetterQueueRecord, number>;

  public constructor() {
    super("wogc_db");
    this.version(1).stores({
      users: "++id,&username,role,createdAt",
      tasks: "++id,status,updatedAt",
      equipment_heartbeats: "++id,equipmentId,observedAt",
      calendar_events: "++id,startAt,endAt",
      meetings: "++id,startAt,endAt",
      notifications: "++id,channel,createdAt",
      audit_log: "++id,action,entity,timestamp",
      message_outbox: "++id,topic,retryCount,createdAt",
    });

    this.version(2).stores({
      users: "++id,&username,role,createdAt",
      tasks: "++id,status,updatedAt",
      equipment_heartbeats: "++id,equipmentId,observedAt",
      calendar_events: "++id,startAt,endAt",
      meetings: "++id,startAt,endAt",
      notifications: "++id,channel,createdAt",
      audit_log: "++id,sequence,hash,action,entity,timestamp",
      message_outbox: "++id,topic,retryCount,createdAt",
      sessions: "++id,userId,role,createdAt,lastSeenAt,terminatedAt",
      system_settings: "++id,&key,updatedAt",
      permission_overrides: "++id,role,scope,updatedAt",
    });

    this.version(3).stores({
      users: "++id,&username,role,createdAt",
      tasks: "++id,status,priority,updatedAt",
      equipment_heartbeats: "++id,equipmentId,observedAt",
      calendar_events: "++id,startAt,endAt",
      meetings: "++id,startAt,endAt",
      meeting_agenda_items: "++id,meetingId,orderIndex,status,createdAt",
      meeting_resolutions: "++id,meetingId,approved,dueDate,createdAt",
      meeting_attachments: "++id,meetingId,mimeType,uploadedAt",
      notifications: "++id,userId,category,createdAt,taskId",
      user_subscriptions: "++id,userId,category,updatedAt",
      notification_read_receipts: "++id,notificationId,userId,viewedAt",
      notification_delivery_logs: "++id,notificationId,userId,eventType,deliveredAt,read",
      audit_log: "++id,sequence,hash,action,entity,timestamp",
      message_outbox: "++id,topic,retryCount,createdAt",
      sessions: "++id,userId,role,createdAt,lastSeenAt,terminatedAt",
      system_settings: "++id,&key,updatedAt",
      permission_overrides: "++id,role,scope,updatedAt",
    });

    this.version(4).stores({
      users: "++id,&username,role,createdAt",
      tasks: "++id,status,priority,updatedAt",
      equipment_heartbeats: "++id,equipmentId,observedAt",
      calendar_events: "++id,startAt,endAt",
      meetings: "++id,startAt,endAt",
      meeting_agenda_items: "++id,meetingId,orderIndex,status,createdAt",
      meeting_resolutions: "++id,meetingId,approved,dueDate,createdAt",
      meeting_attachments: "++id,meetingId,mimeType,uploadedAt",
      notifications: "++id,workspaceId,userId,category,createdAt,taskId",
      user_subscriptions: "++id,workspaceId,userId,category,updatedAt",
      notification_read_receipts: "++id,workspaceId,notificationId,userId,viewedAt",
      notification_delivery_logs: "++id,workspaceId,notificationId,userId,eventType,status,deliveredAt,read",
      audit_log: "++id,sequence,hash,action,entity,timestamp",
      message_outbox: "++id,topic,retryCount,createdAt",
      sessions: "++id,userId,role,createdAt,lastSeenAt,terminatedAt",
      system_settings: "++id,&key,updatedAt",
      permission_overrides: "++id,role,scope,updatedAt",
    });

    this.version(5).stores({
      users: "++id,&username,role,createdAt",
      tasks: "++id,status,priority,updatedAt",
      equipment_heartbeats: "++id,equipmentId,observedAt",
      calendar_events: "++id,startAt,endAt",
      meetings: "++id,startAt,endAt",
      meeting_agenda_items: "++id,meetingId,orderIndex,status,createdAt",
      meeting_resolutions: "++id,meetingId,approved,dueDate,createdAt",
      meeting_attachments: "++id,meetingId,mimeType,uploadedAt",
      notifications: "++id,workspaceId,userId,category,createdAt,taskId",
      user_subscriptions: "++id,workspaceId,userId,category,updatedAt",
      notification_read_receipts: "++id,workspaceId,notificationId,userId,viewedAt",
      notification_delivery_logs: "++id,workspaceId,notificationId,userId,eventType,status,deliveredAt,read",
      audit_log: "++id,sequence,hash,action,entity,timestamp",
      message_outbox: "++id,topic,retryCount,createdAt",
      sessions: "++id,userId,role,createdAt,lastSeenAt,terminatedAt",
      system_settings: "++id,&key,updatedAt",
      permission_overrides: "++id,role,scope,updatedAt",
    });

    this.version(6).stores({
      users: "++id,&username,role,createdAt",
      tasks: "++id,status,priority,updatedAt",
      equipment_heartbeats: "++id,equipmentId,observedAt",
      calendar_events: "++id,startAt,endAt",
      calendar_capacities: "++id,workspaceId,resourceId,slotStart,slotEnd",
      calendar_lockouts: "++id,workspaceId,resourceId,startAt,endAt",
      calendar_holds: "++id,workspaceId,resourceId,startAt,endAt,expiresAt,status",
      meetings: "++id,startAt,endAt",
      meeting_agenda_items: "++id,meetingId,orderIndex,status,createdAt",
      meeting_resolutions: "++id,meetingId,approved,dueDate,createdAt",
      meeting_attachments: "++id,meetingId,mimeType,uploadedAt",
      notifications: "++id,workspaceId,userId,category,createdAt,taskId",
      user_subscriptions: "++id,workspaceId,userId,category,updatedAt",
      notification_read_receipts: "++id,workspaceId,notificationId,userId,viewedAt",
      notification_delivery_logs: "++id,workspaceId,notificationId,userId,eventType,status,deliveredAt,read",
      audit_log: "++id,sequence,hash,action,entity,timestamp",
      message_outbox: "++id,topic,retryCount,createdAt",
      sessions: "++id,userId,role,createdAt,lastSeenAt,terminatedAt",
      system_settings: "++id,&key,updatedAt",
      permission_overrides: "++id,role,scope,updatedAt",
    });

    this.version(7).stores({
      users: "++id,&username,role,createdAt",
      tasks: "++id,status,priority,updatedAt",
      equipment_heartbeats: "++id,equipmentId,observedAt",
      calendar_events: "++id,startAt,endAt",
      calendar_capacities: "++id,workspaceId,resourceId,slotStart,slotEnd",
      calendar_lockouts: "++id,workspaceId,resourceId,startAt,endAt",
      calendar_holds: "++id,workspaceId,resourceId,startAt,endAt,expiresAt,status",
      meetings: "++id,startAt,endAt",
      meeting_agenda_items: "++id,meetingId,orderIndex,status,createdAt",
      meeting_resolutions: "++id,meetingId,approved,dueDate,createdAt",
      meeting_attachments: "++id,meetingId,mimeType,uploadedAt",
      notifications: "++id,workspaceId,userId,category,createdAt,taskId",
      user_subscriptions: "++id,workspaceId,userId,category,updatedAt",
      notification_read_receipts: "++id,workspaceId,notificationId,userId,viewedAt",
      notification_delivery_logs: "++id,workspaceId,notificationId,userId,eventType,status,deliveredAt,read",
      audit_log: "++id,sequence,hash,action,entity,timestamp",
      message_outbox: "++id,topic,retryCount,createdAt",
      sessions: "++id,userId,role,createdAt,lastSeenAt,terminatedAt",
      system_settings: "++id,&key,updatedAt",
      permission_overrides: "++id,role,scope,updatedAt",
      event_processing: "++id,&consumerKey,eventType,processedAt",
    });

    this.version(8).stores({
      users: "++id,&username,badgeId,role,createdAt",
      tasks: "++id,status,workstream,priority,updatedAt,resolutionId",
      equipment_heartbeats: "++id,equipmentId,observedAt",
      calendar_events: "++id,startAt,endAt",
      calendar_capacities: "++id,workspaceId,resourceId,slotStart,slotEnd",
      calendar_lockouts: "++id,workspaceId,resourceId,startAt,endAt",
      calendar_holds: "++id,workspaceId,resourceId,startAt,endAt,expiresAt,status",
      meetings: "++id,startAt,endAt",
      meeting_agenda_items: "++id,meetingId,orderIndex,status,createdAt",
      meeting_resolutions: "++id,meetingId,approved,dueDate,createdAt",
      meeting_attachments: "++id,meetingId,mimeType,uploadedAt",
      notifications: "++id,workspaceId,userId,category,createdAt,taskId",
      user_subscriptions: "++id,workspaceId,userId,category,updatedAt",
      notification_read_receipts: "++id,workspaceId,notificationId,userId,viewedAt",
      notification_delivery_logs: "++id,workspaceId,notificationId,userId,eventType,status,deliveredAt,read",
      audit_log: "++id,sequence,hash,action,entity,timestamp",
      message_outbox: "++id,topic,retryCount,createdAt",
      sessions: "++id,userId,role,createdAt,lastSeenAt,terminatedAt",
      system_settings: "++id,&key,updatedAt",
      permission_overrides: "++id,role,scope,updatedAt",
      event_processing: "++id,&consumerKey,eventType,processedAt",
    });

    this.version(9).stores({
      users: "++id,&username,badgeId,role,createdAt",
      tasks: "++id,status,workstream,priority,updatedAt,resolutionId",
      equipment_heartbeats: "++id,equipmentId,observedAt",
      calendar_events: "++id,startAt,endAt",
      calendar_capacities: "++id,workspaceId,resourceId,slotStart,slotEnd",
      calendar_lockouts: "++id,workspaceId,resourceId,startAt,endAt",
      calendar_holds: "++id,workspaceId,resourceId,startAt,endAt,expiresAt,status",
      meetings: "++id,startAt,endAt",
      meeting_agenda_items: "++id,meetingId,orderIndex,status,createdAt",
      meeting_resolutions: "++id,meetingId,approved,dueDate,createdAt",
      meeting_attachments: "++id,meetingId,mimeType,uploadedAt",
      notifications: "++id,workspaceId,userId,category,createdAt,taskId",
      user_subscriptions: "++id,workspaceId,userId,category,updatedAt",
      notification_read_receipts: "++id,workspaceId,notificationId,userId,viewedAt",
      notification_delivery_logs: "++id,workspaceId,notificationId,userId,eventType,status,deliveredAt,read",
      audit_log: "++id,sequence,hash,action,entity,timestamp",
      message_outbox: "++id,topic,retryCount,createdAt",
      sessions: "++id,userId,role,createdAt,lastSeenAt,terminatedAt",
      system_settings: "++id,&key,updatedAt",
      permission_overrides: "++id,role,scope,updatedAt",
      event_processing: "++id,&consumerKey,eventType,processedAt",
      dead_letter_queue: "++id,status,failedAt,retryCount",
    });

    this.version(10).stores({
      users: "++id,&username,badgeId,role,createdAt",
      tasks: "++id,status,workstream,priority,updatedAt,resolutionId",
      equipment_heartbeats: "++id,equipmentId,observedAt",
      calendar_events: "++id,startAt,endAt",
      calendar_capacities: "++id,workspaceId,resourceId,slotStart,slotEnd",
      calendar_lockouts: "++id,workspaceId,resourceId,startAt,endAt",
      calendar_holds: "++id,workspaceId,resourceId,startAt,endAt,expiresAt,status",
      meetings: "++id,startAt,endAt",
      meeting_agenda_items: "++id,meetingId,orderIndex,status,createdAt",
      meeting_resolutions: "++id,meetingId,approved,dueDate,createdAt",
      meeting_attachments: "++id,meetingId,mimeType,uploadedAt",
      notifications: "++id,workspaceId,userId,category,createdAt,taskId",
      user_subscriptions: "++id,workspaceId,userId,category,updatedAt",
      notification_read_receipts: "++id,workspaceId,notificationId,userId,viewedAt",
      notification_delivery_logs: "++id,workspaceId,notificationId,userId,eventType,status,deliveredAt,read",
      audit_log: "++id,sequence,hash,action,entity,timestamp",
      message_outbox: "++id,topic,retryCount,createdAt",
      sessions: "++id,userId,role,createdAt,lastSeenAt,terminatedAt",
      system_settings: "++id,&key,updatedAt",
      permission_overrides: "++id,role,scope,updatedAt",
      warehouse_sites: "++id,&code,name,active,updatedAt",
      equipment_adapters: "++id,&adapterKey,protocol,active,updatedAt",
      operational_templates: "++id,&templateKey,workstream,active,updatedAt",
      event_processing: "++id,&consumerKey,eventType,processedAt",
      dead_letter_queue: "++id,status,failedAt,retryCount",
    });
  }
}

export const db = new WOGCDatabase();
