import {
  type CalendarCapacityRecord,
  type CalendarEventRecord,
  type CalendarHoldRecord,
  type CalendarLockoutRecord,
  type DeadLetterQueueRecord,
  db,
  type AuditLogRecord,
  type EquipmentAdapterRecord,
  type EquipmentHeartbeatRecord,
  type MessageOutboxRecord,
  type MeetingRecord,
  type MeetingAgendaItemRecord,
  type MeetingAttachmentRecord,
  type MeetingResolutionRecord,
  type NotificationRecord,
  type NotificationDeliveryLogRecord,
  type NotificationReadReceiptRecord,
  type PermissionOverrideRecord,
  type OperationalTemplateRecord,
  type SessionRecord,
  type SystemSettingRecord,
  type TaskRecord,
  type TaskWorkstream,
  type UserSubscriptionRecord,
  type UserRecord,
  type UserProfileRecord,
  type UserRole,
  type WarehouseSiteRecord,
} from "./schema";
import { WOGCError, ensureWOGCError } from "../utils/errors";
import type { WOGCEventPayloadMap, WOGCEventType } from "../types/events";
import type { WOGCEventEnvelope } from "../types/events";

type AuthSnapshot = {
  isAuthenticated: boolean;
  userId: number | null;
  username: string | null;
  role: UserRole | null;
};

let authResolver: () => AuthSnapshot = () => ({
  isAuthenticated: false,
  userId: null,
  username: null,
  role: null,
});

let eventPublisher: <T extends WOGCEventType>(type: T, payload: WOGCEventPayloadMap[T]) => void = () => undefined;

export type RuntimeConfig = {
  version: number;
  idleAutoLockMs: number;
  taskExpiryWindowMs: number;
  heartbeatTimeoutMs: number;
  notificationRateLimitPerDay: number;
  quietHoursDefaultStart: string;
  quietHoursDefaultEnd: string;
  conflictRules: Record<TaskWorkstream, { requireReasonLength: number }>;
};

export type DLQEntry = DeadLetterQueueRecord & { id: number };

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  version: 1,
  idleAutoLockMs: 15 * 60 * 1000,
  taskExpiryWindowMs: 30 * 60 * 1000,
  heartbeatTimeoutMs: 20_000,
  notificationRateLimitPerDay: 3,
  quietHoursDefaultStart: "",
  quietHoursDefaultEnd: "",
  conflictRules: {
    putaway: { requireReasonLength: 8 },
    transport: { requireReasonLength: 8 },
    picking: { requireReasonLength: 12 },
    replenishment: { requireReasonLength: 10 },
  },
};

const permissions: Record<UserRole, { read: Set<string>; write: Set<string> }> = {
  administrator: {
    read: new Set([
      "users",
      "tasks",
      "equipment_heartbeats",
      "calendar_events",
      "calendar_capacities",
      "calendar_lockouts",
      "calendar_holds",
      "meetings",
      "notifications",
      "audit_log",
      "message_outbox",
      "sessions",
      "system_settings",
      "permission_overrides",
      "warehouse_sites",
      "equipment_adapters",
      "operational_templates",
      "meeting_agenda_items",
      "meeting_resolutions",
      "meeting_attachments",
      "user_subscriptions",
      "notification_read_receipts",
      "notification_delivery_logs",
      "dead_letter_queue",
    ]),
    write: new Set([
      "users",
      "tasks",
      "equipment_heartbeats",
      "calendar_events",
      "calendar_capacities",
      "calendar_lockouts",
      "calendar_holds",
      "meetings",
      "notifications",
      "audit_log",
      "message_outbox",
      "sessions",
      "system_settings",
      "permission_overrides",
      "warehouse_sites",
      "equipment_adapters",
      "operational_templates",
      "meeting_agenda_items",
      "meeting_resolutions",
      "meeting_attachments",
      "user_subscriptions",
      "notification_read_receipts",
      "notification_delivery_logs",
      "dead_letter_queue",
    ]),
  },
  dispatcher: {
    read: new Set(["tasks", "equipment_heartbeats", "calendar_events", "calendar_capacities", "calendar_lockouts", "calendar_holds", "meetings", "meeting_resolutions", "notifications", "message_outbox", "notification_delivery_logs", "user_subscriptions", "notification_read_receipts"]),
    write: new Set(["tasks", "equipment_heartbeats", "calendar_events", "calendar_capacities", "calendar_lockouts", "calendar_holds", "notifications", "message_outbox", "notification_delivery_logs", "notification_read_receipts"]),
  },
  facilitator: {
    read: new Set(["tasks", "calendar_events", "calendar_capacities", "calendar_lockouts", "calendar_holds", "meetings", "meeting_agenda_items", "meeting_resolutions", "meeting_attachments", "notifications", "user_subscriptions", "notification_read_receipts", "notification_delivery_logs"]),
    write: new Set(["meetings", "meeting_agenda_items", "meeting_resolutions", "meeting_attachments", "tasks", "notifications", "calendar_events", "calendar_holds", "notification_read_receipts", "user_subscriptions"]),
  },
  operator: {
    read: new Set(["tasks"]),
    write: new Set(["tasks"]),
  },
  viewer: {
    read: new Set(["tasks", "equipment_heartbeats", "calendar_events", "calendar_capacities", "calendar_lockouts", "calendar_holds", "meetings", "meeting_agenda_items", "meeting_resolutions", "notifications", "user_subscriptions", "notification_read_receipts"]),
    write: new Set([]),
  },
  auditor: {
    read: new Set(["audit_log", "dead_letter_queue", "notifications", "meetings", "meeting_attachments", "notification_delivery_logs"]),
    write: new Set([]),
  },
};

const assertPermission = (operation: "read" | "write", table: string): AuthSnapshot => {
  const auth = authResolver();
  if (!auth.isAuthenticated || !auth.role) {
    void appendPermissionDeniedAudit(auth, operation, table, "unauthenticated");
    throw new WOGCError({
      code: "AUTH_403",
      message: `Unauthorized ${operation} on ${table}`,
      context: { operation, table },
      retryable: false,
    });
  }

  const allowed = permissions[auth.role][operation].has(table);
  if (!allowed) {
    void appendPermissionDeniedAudit(auth, operation, table, "role_forbidden");
    throw new WOGCError({
      code: "AUTH_403",
      message: `Role ${auth.role} cannot ${operation} ${table}`,
      context: { operation, table, role: auth.role },
      retryable: false,
    });
  }

  return auth;
};

const digestHex = (value: string): string => {
  let h1 = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h1 ^= value.charCodeAt(i);
    h1 = Math.imul(h1, 16777619);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0");
};

const appendAuditOrThrow = async (
  auth: AuthSnapshot,
  entry: Omit<AuditLogRecord, "id" | "sequence" | "hash" | "actorUserId" | "actorUsername" | "actorRole">,
): Promise<void> => {
  try {
    const previous = await db.audit_log.orderBy("sequence").last();
    const sequence = (previous?.sequence ?? 0) + 1;
    const actorRole = auth.role ?? "anonymous";
    const material = JSON.stringify({
      prevHash: previous?.hash ?? "GENESIS",
      sequence,
      actorRole,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      before: entry.before ?? null,
      after: entry.after ?? null,
      details: entry.details,
      timestamp: entry.timestamp,
    });
    const hash = digestHex(material);
    await db.audit_log.add({
      ...entry,
      sequence,
      hash,
      actorRole,
      actorUserId: auth.userId ?? undefined,
      actorUsername: auth.username ?? undefined,
    });
  } catch (error) {
    throw new WOGCError({
      code: "AUDIT_FAULT",
      message: "Audit trail append failed",
      context: { cause: ensureWOGCError(error).toJSON() },
      retryable: false,
    });
  }
};

const appendPermissionDeniedAudit = async (
  auth: AuthSnapshot,
  operation: "read" | "write",
  table: string,
  reason: "unauthenticated" | "role_forbidden" | "route_guard",
): Promise<void> => {
  try {
    const previous = await db.audit_log.orderBy("sequence").last();
    const sequence = (previous?.sequence ?? 0) + 1;
    const actorRole = auth.role ?? "anonymous";
    const timestamp = now();
    const details = {
      operation,
      table,
      reason,
    };
    const material = JSON.stringify({
      prevHash: previous?.hash ?? "GENESIS",
      sequence,
      actorRole,
      action: "permission.denied",
      entity: table,
      entityId: "n/a",
      before: null,
      after: null,
      details,
      timestamp,
    });
    const hash = digestHex(material);
    await db.audit_log.add({
      sequence,
      hash,
      action: "permission.denied",
      entity: table,
      entityId: "n/a",
      actorRole,
      actorUserId: auth.userId ?? undefined,
      actorUsername: auth.username ?? undefined,
      details,
      timestamp,
    });
  } catch {
    return;
  }
};

const now = (): string => new Date().toISOString();
const WORKSPACE_ID = "default";
const UNAUTHORIZED_ERROR_MESSAGE = "Unauthorized";
const AUDITOR_UNAUTHORIZED_ERROR_MESSAGE = "DAL Unauthorized: Auditors have read-only access";
const systemAuth: AuthSnapshot = {
  isAuthenticated: true,
  userId: null,
  username: "system",
  role: "administrator",
};

const snapshot = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
};

const assertMutationRole = (actingRole: string | null | undefined): void => {
  if (actingRole === "Auditor") {
    throw new Error(AUDITOR_UNAUTHORIZED_ERROR_MESSAGE);
  }
  if (!actingRole) {
    throw new Error(UNAUTHORIZED_ERROR_MESSAGE);
  }
  if (actingRole.trim().toLowerCase() === "auditor") {
    throw new Error(AUDITOR_UNAUTHORIZED_ERROR_MESSAGE);
  }
};

const isQuotaExceeded = (error: unknown): boolean => {
  if (error instanceof DOMException) {
    return error.name === "QuotaExceededError";
  }
  if (typeof error === "object" && error !== null && "name" in error) {
    return String((error as { name?: unknown }).name) === "QuotaExceededError";
  }
  return false;
};

const scopeUserId = (auth: AuthSnapshot): number | undefined => {
  return typeof auth.userId === "number" ? auth.userId : undefined;
};

const validWorkstreams: TaskWorkstream[] = ["putaway", "transport", "picking", "replenishment"];

const normalizeWorkstream = (value: TaskRecord["workstream"] | undefined): TaskWorkstream => {
  if (value && validWorkstreams.includes(value)) {
    return value;
  }
  return "putaway";
};

const normalizeTaskPriority = (value: unknown): TaskRecord["priority"] => {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new WOGCError({
      code: "VAL_PRIORITY_RANGE",
      message: "Task priority must be an integer between 1 and 5.",
      context: { field: "priority", value },
      retryable: false,
    });
  }
  return value as TaskRecord["priority"];
};

const deriveBadgeId = (username: string): string => {
  const normalized = username.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 4).padEnd(4, "X");
  return `${normalized}-${Math.floor(1000 + Math.random() * 9000)}`;
};

const normalizeAdminKey = (value: string): string => value.trim().toUpperCase();

const validateRequired = (value: string, code: string, message: string, field: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new WOGCError({
      code,
      message,
      context: { field },
      retryable: false,
    });
  }
  return trimmed;
};

const maskSensitiveTask = (task: TaskRecord, role: UserRole | null): TaskRecord => {
  if (role === "administrator" || role === "dispatcher" || role === "facilitator" || role === "auditor") {
    return task;
  }
  return {
    ...task,
    title: task.title.length > 10 ? `${task.title.slice(0, 8)}...` : task.title,
    description: task.description ? "REDACTED" : undefined,
  };
};

const maskSensitiveHeartbeat = (row: EquipmentHeartbeatRecord, role: UserRole | null): EquipmentHeartbeatRecord => {
  if (role === "administrator" || role === "dispatcher" || role === "auditor") {
    return row;
  }
  return {
    ...row,
    equipmentSerial: row.equipmentSerial ? "SERIAL-REDACTED" : undefined,
  };
};

const maskSensitiveMeeting = (row: MeetingRecord, role: UserRole | null): MeetingRecord => {
  if (role === "administrator" || role === "facilitator" || role === "auditor") {
    return row;
  }
  return {
    ...row,
    minutes: row.minutes ? "REDACTED" : undefined,
  };
};

class DAL {
  private isOverlapping(startA: string, endA: string, startB: string, endB: string): boolean {
    return Date.parse(startA) < Date.parse(endB) && Date.parse(endA) > Date.parse(startB);
  }

  private async calendarConflictFor(input: { startAt: string; endAt: string; resourceId?: string; excludeEventId?: number }): Promise<{ type: "lockout" | "capacity"; details: Record<string, unknown> } | null> {
    const lockouts = await db.calendar_lockouts.toArray();
    const overlappingLockout = lockouts.find((row) => {
      const resourceMatch = !row.resourceId || !input.resourceId || row.resourceId === input.resourceId;
      return resourceMatch && this.isOverlapping(input.startAt, input.endAt, row.startAt, row.endAt);
    });
    if (overlappingLockout) {
      return {
        type: "lockout",
        details: {
          lockoutId: overlappingLockout.id,
          reason: overlappingLockout.reason,
          startAt: overlappingLockout.startAt,
          endAt: overlappingLockout.endAt,
        },
      };
    }

    const capacities = await db.calendar_capacities.toArray();
    const matchingCapacity = capacities.find((row) => {
      const resourceMatch = !row.resourceId || !input.resourceId || row.resourceId === input.resourceId;
      return resourceMatch && this.isOverlapping(input.startAt, input.endAt, row.slotStart, row.slotEnd);
    });
    if (!matchingCapacity) {
      return null;
    }

    const events = await db.calendar_events.toArray();
    const overlappingEvents = events.filter((row) => {
      if (typeof input.excludeEventId === "number" && row.id === input.excludeEventId) {
        return false;
      }
      const resourceMatch = !matchingCapacity.resourceId || !row.resourceId || row.resourceId === matchingCapacity.resourceId;
      return resourceMatch && this.isOverlapping(input.startAt, input.endAt, row.startAt, row.endAt);
    });

    if (overlappingEvents.length >= matchingCapacity.maxOccupancy) {
      return {
        type: "capacity",
        details: {
          maxOccupancy: matchingCapacity.maxOccupancy,
          currentOccupancy: overlappingEvents.length,
          capacityId: matchingCapacity.id,
        },
      };
    }
    return null;
  }

  public async logPermissionDeniedAttempt(input: {
    operation: "read" | "write";
    target: string;
    reason?: "unauthenticated" | "role_forbidden" | "route_guard";
  }): Promise<void> {
    const auth = authResolver();
    await appendPermissionDeniedAudit(auth, input.operation, input.target, input.reason ?? "role_forbidden");
  }

  public async getTaskById(id: number): Promise<TaskRecord | undefined> {
    const auth = assertPermission("read", "tasks");
    return db.tasks.get(id).then((row) => {
      if (!row) {
        return undefined;
      }
      if (typeof row.scopeUserId === "number" && typeof auth.userId === "number" && row.scopeUserId !== auth.userId) {
        throw new WOGCError({
          code: "AUTH_403",
          message: "Cross-user task access denied",
          context: { taskId: id },
          retryable: false,
        });
      }
      return maskSensitiveTask(row, auth.role);
    }).catch((error) => {
      throw ensureWOGCError(error, {
        code: "DB_READ_FAIL",
        message: "Failed to read task",
        context: { table: "tasks", id },
        retryable: true,
      });
    });
  }

  public async saveTask(task: Omit<TaskRecord, "id" | "updatedAt"> & { id?: number }): Promise<number> {
    const auth = assertPermission("write", "tasks");
    const priority = normalizeTaskPriority(task.priority);
    const payload: TaskRecord = {
      ...task,
      priority,
      workstream: normalizeWorkstream(task.workstream),
      scopeUserId: scopeUserId(auth),
      updatedAt: now(),
    };

    return db
      .transaction("rw", db.tasks, db.audit_log, async () => {
        const before = task.id ? await db.tasks.get(task.id) : null;
        const isAssignmentChange = Boolean(payload.assignee) && payload.assignee !== before?.assignee;
        if (isAssignmentChange && payload.resourceId) {
          const activeLockout = await db.calendar_lockouts
            .where("resourceId")
            .equals(payload.resourceId)
            .and((row) => Date.parse(row.startAt) <= Date.now() && Date.parse(row.endAt) >= Date.now())
            .first();
          if (activeLockout) {
            throw new WOGCError({
              code: "LOCKOUT_CONFLICT",
              message: "Task assignment blocked by active lockout",
              context: { taskId: task.id ?? null, resourceId: payload.resourceId, reason: activeLockout.reason },
              retryable: false,
            });
          }
        }
        const taskId = task.id ? await db.tasks.put(payload) : await db.tasks.add(payload);
        if (payload.status === "done") {
          eventPublisher("tasks.completed", {
            taskId,
            completedAt: now(),
            resolutionId: payload.resolutionId,
          });
        }
        await appendAuditOrThrow(auth, {
          action: task.id ? "task.updated" : "task.created",
          entity: "tasks",
          entityId: String(taskId),
          details: { status: payload.status, title: payload.title },
          timestamp: now(),
        });
        return taskId;
      })
      .catch((error) => {
        if (error instanceof WOGCError) {
          throw error;
        }
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to persist task",
          context: { table: "tasks" },
          retryable: true,
        });
      });
  }

  public async registerLocalUser(input: {
    username: string;
    displayName?: string;
    badgeId?: string;
    passwordHash: string;
    salt: string;
    iterations: number;
    role: UserRole;
    mustResetPassword: boolean;
    allowRoleOverride?: boolean;
  }): Promise<number> {
    const auth = authResolver();
    const effectiveRole: UserRole = input.allowRoleOverride || (auth.isAuthenticated && auth.role === "administrator") ? input.role : "viewer";
    const createdAt = now();
    return db
      .transaction("rw", db.users, db.audit_log, async () => {
        const id = await db.users.add({
          username: input.username,
          displayName: input.displayName,
          badgeId: input.badgeId ?? deriveBadgeId(input.username),
          passwordHash: input.passwordHash,
          salt: input.salt,
          iterations: input.iterations,
          role: effectiveRole,
          mustResetPassword: input.mustResetPassword,
          createdAt,
        });
        await appendAuditOrThrow({ isAuthenticated: false, userId: null, username: null, role: null }, {
          action: "user.registered",
          entity: "users",
          entityId: String(id),
          details: { username: input.username, requestedRole: input.role, effectiveRole, mustResetPassword: input.mustResetPassword },
          timestamp: now(),
        });
        return id;
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to register user",
          context: { table: "users", username: input.username },
          retryable: true,
        });
      });
  }

  public async getUserProfileByUsername(username: string): Promise<UserProfileRecord | undefined> {
    return db.users.where("username").equals(username).first().then((user) => {
      if (!user) {
        return undefined;
      }
      const { passwordHash: _passwordHash, salt: _salt, iterations: _iterations, ...profile } = user;
      return profile;
    }).catch((error) => {
      throw ensureWOGCError(error, {
        code: "DB_READ_FAIL",
        message: "Failed to read user profile",
        context: { table: "users", username },
        retryable: true,
      });
    });
  }

  public async getUserProfile(userId: number): Promise<UserProfileRecord | undefined> {
    return db.users.get(userId).then((user) => {
      if (!user) {
        return undefined;
      }
      const { passwordHash: _passwordHash, salt: _salt, iterations: _iterations, ...profile } = user;
      return profile;
    }).catch((error) => {
      throw ensureWOGCError(error, {
        code: "DB_READ_FAIL",
        message: "Failed to read user",
        context: { userId },
        retryable: true,
      });
    });
  }

  public async getUserById(userId: number): Promise<UserProfileRecord | undefined> {
    return this.getUserProfile(userId);
  }

  public async updateUserPassword(input: {
    userId: number;
    passwordHash: string;
    salt: string;
    iterations: number;
    mustResetPassword: boolean;
  }): Promise<void> {
    const auth = authResolver();
    const selfServe = auth.isAuthenticated && auth.userId === input.userId;
    if (!selfServe) {
      assertPermission("write", "users");
    }
    await db
      .transaction("rw", db.users, db.audit_log, async () => {
        const before = await db.users.get(input.userId);
        if (!before) {
          throw new WOGCError({
            code: "USER_404",
            message: "User not found",
            context: { userId: input.userId },
            retryable: false,
          });
        }
        await db.users.update(input.userId, {
          passwordHash: input.passwordHash,
          salt: input.salt,
          iterations: input.iterations,
          mustResetPassword: input.mustResetPassword,
        });
        await appendAuditOrThrow(auth, {
          action: "user.password_updated",
          entity: "users",
          entityId: String(input.userId),
          before: { mustResetPassword: before.mustResetPassword ?? false },
          after: { mustResetPassword: input.mustResetPassword },
          details: {},
          timestamp: now(),
        });
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to update password",
          context: { userId: input.userId },
          retryable: true,
        });
      });
  }

  public async listUsers(options?: { bypassAuth?: boolean }): Promise<Array<UserProfileRecord & { id: number }>> {
    if (!options?.bypassAuth) {
      assertPermission("read", "users");
    }
    return db.users
      .orderBy("createdAt")
      .reverse()
      .toArray()
      .then((users) => users.filter((user): user is UserRecord & { id: number } => typeof user.id === "number"))
      .then((users) => users.map((user) => {
        const { passwordHash: _passwordHash, salt: _salt, iterations: _iterations, ...profile } = user;
        return profile;
      }))
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_READ_FAIL",
          message: "Failed to read users",
          context: {},
          retryable: true,
        });
      });
  }

  public async saveUserConfig(user: Omit<UserRecord, "id" | "createdAt"> & { id?: number }): Promise<number> {
    const auth = assertPermission("write", "users");
    return db
      .transaction("rw", db.users, db.audit_log, async () => {
        const before = user.id ? await db.users.get(user.id) : null;
        const userId = user.id
          ? await db.users.put({ ...user, createdAt: before?.createdAt ?? now() })
          : await db.users.add({ ...user, createdAt: now() });
        const after = await db.users.get(userId);
        await appendAuditOrThrow(auth, {
          action: user.id ? "user.updated" : "user.created",
          entity: "users",
          entityId: String(userId),
          before: snapshot(before),
          after: snapshot(after),
          details: { role: user.role },
          timestamp: now(),
        });
        return userId;
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to save user",
          context: { username: user.username },
          retryable: true,
        });
      });
  }

  public async deleteUser(userId: number): Promise<void> {
    const auth = assertPermission("write", "users");
    await db
      .transaction("rw", db.users, db.audit_log, async () => {
        const before = await db.users.get(userId);
        await db.users.delete(userId);
        await appendAuditOrThrow(auth, {
          action: "user.deleted",
          entity: "users",
          entityId: String(userId),
          before: snapshot(before),
          after: null,
          details: {},
          timestamp: now(),
        });
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to delete user",
          context: { userId },
          retryable: true,
        });
      });
  }

  public async listTasks(filters?: { workstream?: TaskWorkstream; sortByWorkstream?: boolean }): Promise<Array<TaskRecord & { id: number }>> {
    const auth = assertPermission("read", "tasks");
    const scopedUserId = scopeUserId(auth);
    return db.tasks
      .orderBy("updatedAt")
      .reverse()
      .toArray()
      .then((tasks) => (typeof scopedUserId === "number" ? tasks.filter((task) => task.scopeUserId === scopedUserId) : tasks))
      .then((tasks) => (filters?.workstream ? tasks.filter((task) => task.workstream === filters.workstream) : tasks))
      .then((tasks) => {
        if (!filters?.sortByWorkstream) {
          return tasks;
        }
        return [...tasks].sort((a, b) => a.workstream.localeCompare(b.workstream));
      })
      .then((tasks) => tasks.map((task) => maskSensitiveTask(task, auth.role)))
      .then((tasks) => tasks.filter((task): task is TaskRecord & { id: number } => typeof task.id === "number"))
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_READ_FAIL",
          message: "Failed to list tasks",
          context: { table: "tasks" },
          retryable: true,
        });
      });
  }

  public async reclassifyTaskWorkstream(taskId: number, workstream: TaskWorkstream): Promise<void> {
    const auth = assertPermission("write", "tasks");
    if (auth.role !== "administrator" && auth.role !== "dispatcher") {
      throw new WOGCError({
        code: "AUTH_403",
        message: "Only administrators and dispatchers may reclassify workstreams",
        context: { taskId, role: auth.role },
        retryable: false,
      });
    }
    const normalized = normalizeWorkstream(workstream);
    await db.transaction("rw", db.tasks, db.audit_log, async () => {
      const before = await db.tasks.get(taskId);
      if (!before) {
        throw new WOGCError({
          code: "TASK_404",
          message: "Task not found for reclassification",
          context: { taskId },
          retryable: false,
        });
      }
      await db.tasks.update(taskId, { workstream: normalized, updatedAt: now() });
      const after = await db.tasks.get(taskId);
      await appendAuditOrThrow(auth, {
        action: "task.workstream_reclassified",
        entity: "tasks",
        entityId: String(taskId),
        before: snapshot(before),
        after: snapshot(after),
        details: { workstream: normalized },
        timestamp: now(),
      });
    });
  }

  public async resolveTaskConflict(input: {
    taskId: number;
    keepResource: boolean;
    reason: string;
  }): Promise<void> {
    const auth = assertPermission("write", "tasks");
    const reason = input.reason.trim();
    const task = await db.tasks.get(input.taskId);
    const workstream = normalizeWorkstream(task?.workstream);
    const runtimeConfig = await this.getPublicConfig();
    const minReasonLength = runtimeConfig.conflictRules[workstream]?.requireReasonLength ?? DEFAULT_RUNTIME_CONFIG.conflictRules[workstream].requireReasonLength;
    if (reason.length < minReasonLength) {
      throw new WOGCError({
        code: "VAL_REASON_REQUIRED",
        message: `Resolution reason must be at least ${minReasonLength} characters for ${workstream}`,
        context: { field: "reason" },
        retryable: false,
      });
    }

    await db
      .transaction("rw", db.tasks, db.audit_log, async () => {
        const txTask = await db.tasks.get(input.taskId);
        if (!txTask || typeof txTask.id !== "number") {
          throw new WOGCError({
            code: "TASK_404",
            message: "Task conflict target not found",
            context: { taskId: input.taskId },
            retryable: false,
          });
        }

        await db.tasks.update(txTask.id, {
          resourceId: input.keepResource ? txTask.resourceId : undefined,
          updatedAt: now(),
        });

        await appendAuditOrThrow(auth, {
          action: "task.conflict_resolved",
          entity: "tasks",
          entityId: String(txTask.id),
          details: {
            keepResource: input.keepResource,
            reason,
            previousResourceId: txTask.resourceId ?? null,
            workstream,
          },
          timestamp: now(),
        });
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "CONFLICT_RESOLVE_FAIL",
          message: "Failed to resolve task conflict",
          context: { taskId: input.taskId },
          retryable: true,
        });
      });
  }

  public async listHeartbeats(limit = 60): Promise<Array<EquipmentHeartbeatRecord & { id: number }>> {
    const auth = assertPermission("read", "equipment_heartbeats");
    const scopedUserId = scopeUserId(auth);
    return db.equipment_heartbeats
      .orderBy("observedAt")
      .reverse()
      .limit(limit)
      .toArray()
      .then((rows) => (typeof scopedUserId === "number" ? rows.filter((row) => row.scopeUserId === scopedUserId) : rows))
      .then((rows) => rows.map((row) => maskSensitiveHeartbeat(row, auth.role)))
      .then((rows) => rows.filter((row): row is EquipmentHeartbeatRecord & { id: number } => typeof row.id === "number"))
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_READ_FAIL",
          message: "Failed to list heartbeats",
          context: { table: "equipment_heartbeats", limit },
          retryable: true,
        });
      });
  }

  public async listCalendarEvents(): Promise<Array<CalendarEventRecord & { id: number }>> {
    const auth = assertPermission("read", "calendar_events");
    const scopedUserId = scopeUserId(auth);
    return db.calendar_events
      .orderBy("startAt")
      .toArray()
      .then((rows) => (typeof scopedUserId === "number" ? rows.filter((row) => row.scopeUserId === scopedUserId) : rows))
      .then((rows) => rows.filter((row): row is CalendarEventRecord & { id: number } => typeof row.id === "number"))
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_READ_FAIL",
          message: "Failed to list calendar events",
          context: { table: "calendar_events" },
          retryable: true,
        });
      });
  }

  public async saveCalendarEvent(event: Omit<CalendarEventRecord, "id">, options?: { allowOverride?: boolean; overrideReason?: string }): Promise<number> {
    const auth = assertPermission("write", "calendar_events");
    const payload = { ...event, scopeUserId: scopeUserId(auth) };

    if (!options?.allowOverride) {
      const conflict = await this.calendarConflictFor({ startAt: payload.startAt, endAt: payload.endAt, resourceId: payload.resourceId });
      if (conflict) {
        throw new WOGCError({
          code: conflict.type === "lockout" ? "LOCKOUT_CONFLICT" : "CAPACITY_CONFLICT",
          message: conflict.type === "lockout" ? "Scheduling blocked by lockout window" : "Scheduling exceeds configured capacity",
          context: conflict.details,
          retryable: false,
        });
      }
    }

    return db
      .transaction("rw", db.calendar_events, db.audit_log, async () => {
        const id = await db.calendar_events.add(payload);
        await appendAuditOrThrow(auth, {
          action: "calendar.created",
          entity: "calendar_events",
          entityId: String(id),
          details: {
            category: payload.category ?? "occupancy",
            resourceId: payload.resourceId ?? null,
            override: Boolean(options?.allowOverride),
            overrideReason: options?.overrideReason ?? null,
          },
          timestamp: now(),
        });
        return id;
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to save calendar event",
          context: { table: "calendar_events" },
          retryable: true,
        });
      });
  }

  public async upsertCalendarEvent(event: Omit<CalendarEventRecord, "id"> & { id?: number }, options?: { allowOverride?: boolean; overrideReason?: string }): Promise<number> {
    const auth = assertPermission("write", "calendar_events");
    const payload = { ...event, scopeUserId: scopeUserId(auth) };

    if (!options?.allowOverride) {
      const conflict = await this.calendarConflictFor({
        startAt: payload.startAt,
        endAt: payload.endAt,
        resourceId: payload.resourceId,
        excludeEventId: event.id,
      });
      if (conflict) {
        throw new WOGCError({
          code: conflict.type === "lockout" ? "LOCKOUT_CONFLICT" : "CAPACITY_CONFLICT",
          message: conflict.type === "lockout" ? "Scheduling blocked by lockout window" : "Scheduling exceeds configured capacity",
          context: conflict.details,
          retryable: false,
        });
      }
    }

    return db
      .transaction("rw", db.calendar_events, db.audit_log, async () => {
        const before = event.id ? await db.calendar_events.get(event.id) : null;
        const id = event.id ? await db.calendar_events.put(payload) : await db.calendar_events.add(payload);
        const after = await db.calendar_events.get(id);
        await appendAuditOrThrow(auth, {
          action: event.id ? "calendar.updated" : "calendar.created",
          entity: "calendar_events",
          entityId: String(id),
          before: snapshot(before),
          after: snapshot(after),
          details: {
            category: payload.category ?? "occupancy",
            resourceId: payload.resourceId ?? null,
            override: Boolean(options?.allowOverride),
            overrideReason: options?.overrideReason ?? null,
          },
          timestamp: now(),
        });
        return id;
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to upsert calendar event",
          context: { table: "calendar_events" },
          retryable: true,
        });
      });
  }

  public async listCalendarCapacities(): Promise<Array<CalendarCapacityRecord & { id: number }>> {
    assertPermission("read", "calendar_capacities");
    return db.calendar_capacities
      .toArray()
      .then((rows) => rows.filter((row): row is CalendarCapacityRecord & { id: number } => typeof row.id === "number"));
  }

  public async saveCalendarCapacity(input: Omit<CalendarCapacityRecord, "id" | "createdAt" | "workspaceId"> & { id?: number }): Promise<number> {
    const auth = assertPermission("write", "calendar_capacities");
    return db.transaction("rw", db.calendar_capacities, db.audit_log, async () => {
      const before = input.id ? await db.calendar_capacities.get(input.id) : null;
      const payload = {
        ...input,
        workspaceId: WORKSPACE_ID,
        createdAt: before?.createdAt ?? now(),
      };
      const id = input.id ? await db.calendar_capacities.put({ ...payload, id: input.id }) : await db.calendar_capacities.add(payload);
      const after = await db.calendar_capacities.get(id);
      await appendAuditOrThrow(auth, {
        action: input.id ? "calendar.capacity_updated" : "calendar.capacity_created",
        entity: "calendar_capacities",
        entityId: String(id),
        before: snapshot(before),
        after: snapshot(after),
        details: { resourceId: payload.resourceId ?? null, maxOccupancy: payload.maxOccupancy },
        timestamp: now(),
      });
      return id;
    });
  }

  public async listCalendarLockouts(): Promise<Array<CalendarLockoutRecord & { id: number }>> {
    assertPermission("read", "calendar_lockouts");
    return db.calendar_lockouts
      .toArray()
      .then((rows) => rows.filter((row): row is CalendarLockoutRecord & { id: number } => typeof row.id === "number"));
  }

  public async saveCalendarLockout(input: Omit<CalendarLockoutRecord, "id" | "createdAt" | "workspaceId"> & { id?: number }): Promise<number> {
    const auth = assertPermission("write", "calendar_lockouts");
    return db.transaction("rw", db.calendar_lockouts, db.audit_log, async () => {
      const before = input.id ? await db.calendar_lockouts.get(input.id) : null;
      const payload = {
        ...input,
        workspaceId: WORKSPACE_ID,
        createdAt: before?.createdAt ?? now(),
      };
      const id = input.id ? await db.calendar_lockouts.put({ ...payload, id: input.id }) : await db.calendar_lockouts.add(payload);
      const after = await db.calendar_lockouts.get(id);
      await appendAuditOrThrow(auth, {
        action: input.id ? "calendar.lockout_updated" : "calendar.lockout_created",
        entity: "calendar_lockouts",
        entityId: String(id),
        before: snapshot(before),
        after: snapshot(after),
        details: { reason: payload.reason, resourceId: payload.resourceId ?? null },
        timestamp: now(),
      });
      return id;
    });
  }

  public async listCalendarHolds(): Promise<Array<CalendarHoldRecord & { id: number }>> {
    assertPermission("read", "calendar_holds");
    return db.calendar_holds
      .toArray()
      .then((rows) => rows.filter((row): row is CalendarHoldRecord & { id: number } => typeof row.id === "number"));
  }

  public async saveCalendarHold(input: Omit<CalendarHoldRecord, "id" | "createdAt" | "workspaceId" | "status"> & { id?: number; status?: CalendarHoldRecord["status"] }): Promise<number> {
    const auth = assertPermission("write", "calendar_holds");
    return db.transaction("rw", db.calendar_holds, db.audit_log, async () => {
      const before = input.id ? await db.calendar_holds.get(input.id) : null;
      const payload = {
        ...input,
        workspaceId: WORKSPACE_ID,
        status: input.status ?? before?.status ?? "active",
        createdAt: before?.createdAt ?? now(),
      };
      const id = input.id ? await db.calendar_holds.put({ ...payload, id: input.id }) : await db.calendar_holds.add(payload);
      const after = await db.calendar_holds.get(id);
      await appendAuditOrThrow(auth, {
        action: input.id ? "calendar.hold_updated" : "calendar.hold_created",
        entity: "calendar_holds",
        entityId: String(id),
        before: snapshot(before),
        after: snapshot(after),
        details: { expiresAt: payload.expiresAt, status: payload.status },
        timestamp: now(),
      });
      if (!input.id) {
        eventPublisher("calendar.hold.created", {
          holdId: id,
          resourceId: payload.resourceId,
          expiresAt: payload.expiresAt,
        });
      }
      return id;
    });
  }

  public async expireCalendarHoldsNow(): Promise<number> {
    const auth = assertPermission("write", "calendar_holds");
    const cutoff = now();
    return db.transaction("rw", db.calendar_holds, db.audit_log, async () => {
      const rows = await db.calendar_holds.where("status").equals("active").toArray();
      let expired = 0;
      for (const row of rows) {
        if (row.expiresAt <= cutoff && typeof row.id === "number") {
          await db.calendar_holds.update(row.id, { status: "expired" });
          expired += 1;
          eventPublisher("calendar.hold.expired", {
            holdId: row.id,
            expiredAt: now(),
          });
          await appendAuditOrThrow(auth, {
            action: "calendar.hold_expired",
            entity: "calendar_holds",
            entityId: String(row.id),
            before: snapshot(row),
            after: { ...snapshot(row), status: "expired" },
            details: { expiresAt: row.expiresAt },
            timestamp: now(),
          });
        }
      }
      return expired;
    });
  }

  public async convertCalendarHoldToTask(holdId: number, taskTitle: string, workstream: TaskWorkstream): Promise<number> {
    const auth = assertPermission("write", "calendar_holds");
    return db.transaction("rw", db.calendar_holds, db.tasks, db.audit_log, async () => {
      const hold = await db.calendar_holds.get(holdId);
      if (!hold || typeof hold.id !== "number") {
        throw new WOGCError({
          code: "HOLD_404",
          message: "Calendar hold not found",
          context: { holdId },
          retryable: false,
        });
      }
      const taskId = await db.tasks.add({
        scopeUserId: scopeUserId(auth),
        title: taskTitle,
        status: "open",
        workstream: normalizeWorkstream(workstream),
        resourceId: hold.resourceId,
        createdAt: now(),
        updatedAt: now(),
      });
      await db.calendar_holds.update(hold.id, { status: "converted" });
      await appendAuditOrThrow(auth, {
        action: "calendar.hold_converted",
        entity: "calendar_holds",
        entityId: String(hold.id),
        before: snapshot(hold),
        after: { ...snapshot(hold), status: "converted", taskId },
        details: { taskId, workstream: normalizeWorkstream(workstream) },
        timestamp: now(),
      });
      eventPublisher("calendar.hold.converted", {
        holdId: hold.id,
        taskId,
        convertedAt: now(),
      });
      return taskId;
    });
  }

  public async ensureCalendarHoldConsistency(input: {
    holdId: number;
    resourceId?: string;
    expiresAt: string;
  }): Promise<void> {
    const holdMarker = `hold:${input.holdId}`;
    await db.transaction("rw", db.calendar_holds, db.calendar_events, db.calendar_capacities, db.audit_log, async () => {
      const hold = await db.calendar_holds.get(input.holdId);
      if (!hold) {
        throw new WOGCError({
          code: "HOLD_404",
          message: "Calendar hold not found",
          context: { holdId: input.holdId },
          retryable: false,
        });
      }

      let blockCreated = false;
      const existingBlock = (await db.calendar_events.toArray()).find((row) => row.category === "holds" && row.title === holdMarker);
      if (!existingBlock) {
        await db.calendar_events.add({
          scopeUserId: undefined,
          title: holdMarker,
          eventType: "task",
          recurrenceRule: "none",
          category: "holds",
          resourceId: hold.resourceId,
          startAt: hold.startAt,
          endAt: hold.endAt,
        });
        blockCreated = true;
      }

      let capacityReserved = false;
      const existingCapacity = await db.calendar_capacities.where("workspaceId").equals(holdMarker).first();
      if (!existingCapacity) {
        await db.calendar_capacities.add({
          workspaceId: holdMarker,
          resourceId: hold.resourceId,
          slotStart: hold.startAt,
          slotEnd: hold.endAt,
          maxOccupancy: 1,
          createdAt: now(),
        });
        capacityReserved = true;
      }

      if (hold.status !== "active") {
        await db.calendar_holds.update(input.holdId, { status: "active" });
      }

      await appendAuditOrThrow(systemAuth, {
        action: "calendar.hold_consistency_created",
        entity: "calendar_holds",
        entityId: String(input.holdId),
        details: {
          blockCreated,
          capacityReserved,
          resourceId: hold.resourceId ?? null,
          expiresAt: input.expiresAt,
        },
        timestamp: now(),
      });
    });
  }

  public async reconcileCalendarHoldExpired(input: {
    holdId: number;
    expiredAt: string;
  }): Promise<void> {
    const holdMarker = `hold:${input.holdId}`;
    let dispatcherCount = 0;
    await db.transaction("rw", db.calendar_holds, db.calendar_events, db.calendar_capacities, db.audit_log, async () => {
      const hold = await db.calendar_holds.get(input.holdId);
      const blockRows = (await db.calendar_events.toArray()).filter((row) => row.category === "holds" && row.title === holdMarker);
      const blockIds = blockRows.map((row) => row.id).filter((id): id is number => typeof id === "number");
      const capacityRows = await db.calendar_capacities.where("workspaceId").equals(holdMarker).toArray();
      for (const blockId of blockIds) {
        if (typeof blockId === "number") {
          await db.calendar_events.delete(blockId);
        }
      }
      for (const row of capacityRows) {
        if (typeof row.id === "number") {
          await db.calendar_capacities.delete(row.id);
        }
      }
      if (hold && hold.status !== "converted") {
        await db.calendar_holds.update(input.holdId, { status: "expired" });
      }

      const dispatchers = await db.users.where("role").equals("dispatcher").toArray();
      dispatcherCount = dispatchers.filter((row) => typeof row.id === "number").length;

      await appendAuditOrThrow(systemAuth, {
        action: "calendar.hold_consistency_expired",
        entity: "calendar_holds",
        entityId: String(input.holdId),
        details: {
          releasedBlocks: blockIds.length,
          releasedCapacities: capacityRows.length,
          notifiedDispatchers: dispatcherCount,
          expiredAt: input.expiredAt,
        },
        timestamp: now(),
      });
    });

    const dispatchers = await db.users.where("role").equals("dispatcher").toArray();
    for (const user of dispatchers) {
      if (typeof user.id !== "number") {
        continue;
      }
      await db.notifications.add({
        userId: user.id,
        channel: "ui",
        category: "system",
        eventType: "calendar.hold.expired",
        level: "warn",
        message: `Hold ${input.holdId} expired and capacity was released.`,
        createdAt: now(),
        workspaceId: WORKSPACE_ID,
      });
    }
  }

  public async reconcileCalendarHoldConverted(input: {
    holdId: number;
    taskId: number;
    convertedAt: string;
  }): Promise<void> {
    const holdMarker = `hold:${input.holdId}`;
    let releasedBlocks = 0;
    let releasedCapacities = 0;
    await db.transaction("rw", db.calendar_holds, db.calendar_events, db.calendar_capacities, db.tasks, async () => {
      const task = await db.tasks.get(input.taskId);
      if (!task) {
        throw new WOGCError({
          code: "TASK_404",
          message: "Converted task not found",
          context: { taskId: input.taskId, holdId: input.holdId },
          retryable: false,
        });
      }

      const blockRows = (await db.calendar_events.toArray()).filter((row) => row.category === "holds" && row.title === holdMarker);
      const blockIds = blockRows.map((row) => row.id).filter((id): id is number => typeof id === "number");
      const capacityRows = await db.calendar_capacities.where("workspaceId").equals(holdMarker).toArray();
      releasedBlocks = blockIds.length;
      releasedCapacities = capacityRows.length;
      for (const blockId of blockIds) {
        if (typeof blockId === "number") {
          await db.calendar_events.delete(blockId);
        }
      }
      for (const row of capacityRows) {
        if (typeof row.id === "number") {
          await db.calendar_capacities.delete(row.id);
        }
      }
      await db.calendar_holds.update(input.holdId, { status: "converted" });
    });
    await appendAuditOrThrow(systemAuth, {
      action: "calendar.hold_consistency_converted",
      entity: "calendar_holds",
      entityId: String(input.holdId),
      details: {
        taskId: input.taskId,
        releasedBlocks,
        releasedCapacities,
        convertedAt: input.convertedAt,
      },
      timestamp: now(),
    });
  }

  public async listMeetings(): Promise<Array<MeetingRecord & { id: number }>> {
    const auth = assertPermission("read", "meetings");
    const scopedUserId = scopeUserId(auth);
    return db.meetings
      .orderBy("startAt")
      .reverse()
      .toArray()
      .then((rows) => {
        if (auth.role === "administrator" || auth.role === "auditor") {
          return rows;
        }
        if (typeof scopedUserId === "number") {
          return rows.filter((row) => row.scopeUserId === scopedUserId);
        }
        return [];
      })
      .then((rows) => rows.map((row) => maskSensitiveMeeting(row, auth.role)))
      .then((rows) => rows.filter((row): row is MeetingRecord & { id: number } => typeof row.id === "number"))
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_READ_FAIL",
          message: "Failed to list meetings",
          context: { table: "meetings" },
          retryable: true,
        });
      });
  }

  public async saveMeeting(meeting: Omit<MeetingRecord, "id"> & { id?: number }): Promise<number> {
    const auth = assertPermission("write", "meetings");
    const payload = { ...meeting, scopeUserId: scopeUserId(auth) };
    return db
      .transaction("rw", db.meetings, db.audit_log, async () => {
        const id = meeting.id ? await db.meetings.put(payload) : await db.meetings.add(payload);
        await appendAuditOrThrow(auth, {
          action: payload.id ? "meeting.updated" : "meeting.created",
          entity: "meetings",
          entityId: String(id),
          details: { subject: payload.subject, facilitator: payload.facilitator ?? null },
          timestamp: now(),
        });
        return id;
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to save meeting",
          context: { table: "meetings" },
          retryable: true,
        });
      });
  }

  public async listNotifications(limit = 300, userId?: number, options?: { bypassAuth?: boolean }): Promise<Array<NotificationRecord & { id: number }>> {
    const auth = options?.bypassAuth ? systemAuth : assertPermission("read", "notifications");
    if (!options?.bypassAuth && typeof userId === "number" && auth.role !== "administrator" && auth.role !== "auditor" && auth.userId !== userId) {
      throw new WOGCError({
        code: "AUTH_403",
        message: "Cannot read notifications for another user",
        context: { userId },
        retryable: false,
      });
    }
    const query = db.notifications
      .orderBy("createdAt")
      .reverse()
      .limit(limit)
      .toArray();
    return query
      .then((rows) => rows.filter((row) => (row.workspaceId ?? WORKSPACE_ID) === WORKSPACE_ID))
      .then((rows) => {
        if (auth.role === "administrator" || auth.role === "auditor") {
          return typeof userId === "number" ? rows.filter((row) => row.userId === userId) : rows;
        }
        if (typeof auth.userId === "number") {
          return rows.filter((row) => row.userId === auth.userId);
        }
        return [];
      })
      .then((rows) => rows.filter((row): row is NotificationRecord & { id: number } => typeof row.id === "number"))
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_READ_FAIL",
          message: "Failed to read notifications",
          context: { table: "notifications", limit },
          retryable: true,
        });
      });
  }

  public async saveNotification(notification: Omit<NotificationRecord, "id" | "createdAt" | "channel"> & { createdAt?: string; channel?: "ui" }, options?: { bypassAuth?: boolean }): Promise<number> {
    const auth = options?.bypassAuth ? systemAuth : assertPermission("write", "notifications");
    const createdAt = notification.createdAt ?? now();
    return db
      .transaction("rw", db.notifications, db.audit_log, async () => {
        const id = await db.notifications.add({
          userId: notification.userId,
          workspaceId: WORKSPACE_ID,
          category: notification.category,
          channel: "ui",
          message: notification.message,
          level: notification.level,
          eventType: notification.eventType,
          taskId: notification.taskId,
          createdAt,
        });
        await appendAuditOrThrow(auth, {
          action: "notification.created",
          entity: "notifications",
          entityId: String(id),
          details: {
            channel: "ui",
            category: notification.category,
            level: notification.level ?? "info",
            eventType: notification.eventType ?? "manual",
          },
          timestamp: now(),
        });
        return id;
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to save notification",
          context: { table: "notifications" },
          retryable: true,
        });
      });
  }

  public async enqueueEquipmentCommand(input: {
    topic: string;
    equipmentId: string;
    command: string;
    args?: Record<string, unknown>;
    actingRole: string;
  }): Promise<number> {
    if (input.actingRole === "Auditor") throw new Error("DAL Unauthorized: Auditors have read-only access");
    assertMutationRole(input.actingRole);
    const auth = assertPermission("write", "message_outbox");
    return db
      .transaction("rw", db.message_outbox, db.audit_log, async () => {
        const id = await db.message_outbox.add({
          topic: input.topic,
          payload: {
            equipmentId: input.equipmentId,
            command: input.command,
            args: input.args ?? {},
          },
          retryCount: 0,
          createdAt: now(),
        });
        await appendAuditOrThrow(auth, {
          action: "outbox.command_queued",
          entity: "message_outbox",
          entityId: String(id),
          details: { equipmentId: input.equipmentId, command: input.command },
          timestamp: now(),
        });
        return id;
      })
      .catch((error) => {
        if (isQuotaExceeded(error)) {
          throw new WOGCError({
            code: "STORAGE_FULL",
            message: "Storage Full",
            context: { table: "message_outbox", equipmentId: input.equipmentId },
            retryable: true,
          });
        }
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to queue equipment command",
          context: { table: "message_outbox", equipmentId: input.equipmentId },
          retryable: true,
        });
      });
  }

  public async getPendingOutbox(limit = 25): Promise<Array<MessageOutboxRecord & { id: number }>> {
    assertPermission("read", "message_outbox");
    return db.message_outbox
      .orderBy("createdAt")
      .limit(limit)
      .toArray()
      .then((records) => records.filter((record): record is MessageOutboxRecord & { id: number } => typeof record.id === "number"))
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_READ_FAIL",
          message: "Failed to read outbox",
          context: { table: "message_outbox", limit },
          retryable: true,
        });
      });
  }

  public async bumpOutboxRetry(messageId: number, actingRole: string): Promise<void> {
    if (actingRole === "Auditor") throw new Error("DAL Unauthorized: Auditors have read-only access");
    assertMutationRole(actingRole);
    const auth = assertPermission("write", "message_outbox");
    await db
      .transaction("rw", db.message_outbox, db.audit_log, async () => {
        const row = await db.message_outbox.get(messageId);
        if (!row) {
          return;
        }
        await db.message_outbox.update(messageId, { retryCount: row.retryCount + 1 });
        await appendAuditOrThrow(auth, {
          action: "outbox.retry_incremented",
          entity: "message_outbox",
          entityId: String(messageId),
          details: { previousRetryCount: row.retryCount, nextRetryCount: row.retryCount + 1 },
          timestamp: now(),
        });
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to increment outbox retry",
          context: { table: "message_outbox", messageId },
          retryable: true,
        });
      });
  }

  public async deleteOutboxMessage(messageId: number, actingRole: string): Promise<void> {
    if (actingRole === "Auditor") throw new Error("DAL Unauthorized: Auditors have read-only access");
    assertMutationRole(actingRole);
    const auth = assertPermission("write", "message_outbox");
    await db
      .transaction("rw", db.message_outbox, db.audit_log, async () => {
        await db.message_outbox.delete(messageId);
        await appendAuditOrThrow(auth, {
          action: "outbox.deleted",
          entity: "message_outbox",
          entityId: String(messageId),
          details: {},
          timestamp: now(),
        });
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to delete outbox row",
          context: { table: "message_outbox", messageId },
          retryable: true,
        });
      });
  }

  public async recordHeartbeat(heartbeat: Omit<EquipmentHeartbeatRecord, "id">): Promise<number> {
    const auth = assertPermission("write", "equipment_heartbeats");
    const payload = { ...heartbeat, scopeUserId: scopeUserId(auth) };
    return db
      .transaction("rw", db.equipment_heartbeats, db.audit_log, async () => {
        const id = await db.equipment_heartbeats.add(payload);
        await appendAuditOrThrow(auth, {
          action: "equipment.heartbeat",
          entity: "equipment_heartbeats",
          entityId: String(id),
          details: { equipmentId: payload.equipmentId, status: payload.status },
          timestamp: now(),
        });
        return id;
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to record heartbeat",
          context: { table: "equipment_heartbeats", equipmentId: heartbeat.equipmentId },
          retryable: true,
        });
      });
  }

  public async getExpirableTasks(cutoffISO: string): Promise<Array<TaskRecord & { id: number }>> {
    const auth = assertPermission("read", "tasks");
    const scopedUserId = scopeUserId(auth);
    return db.tasks
      .toArray()
      .then((tasks) => tasks.filter((task) => task.createdAt <= cutoffISO && task.status !== "done" && task.status !== "expired" && !task.acknowledgedAt))
      .then((tasks) => (typeof scopedUserId === "number" ? tasks.filter((task) => task.scopeUserId === scopedUserId) : tasks))
      .then((tasks) => tasks.filter((task): task is TaskRecord & { id: number } => typeof task.id === "number"))
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_READ_FAIL",
          message: "Failed to query expirable tasks",
          context: { table: "tasks", cutoffISO },
          retryable: true,
        });
      });
  }

  public async expireTasks(taskIds: number[]): Promise<number> {
    const auth = assertPermission("write", "tasks");
    if (taskIds.length === 0) {
      return 0;
    }

    return db
      .transaction("rw", db.tasks, db.audit_log, async () => {
        let count = 0;
        for (const taskId of taskIds) {
          const updated = await db.tasks.update(taskId, { status: "expired", updatedAt: now() });
          if (updated > 0) {
            count += 1;
            await appendAuditOrThrow(auth, {
              action: "task.expired",
              entity: "tasks",
              entityId: String(taskId),
              details: { reason: "unacknowledged_timeout" },
              timestamp: now(),
            });
          }
        }
        return count;
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to expire tasks",
          context: { table: "tasks", taskIds },
          retryable: true,
        });
      });
  }

  public async ensureAdminSeed(input: {
    username: string;
    displayName: string;
    temporaryPasswordHash: string;
    salt: string;
    iterations: number;
  }): Promise<{ created: boolean; userId: number }> {
    const existing = await db.users.where("username").equals(input.username).first();
    if (existing && typeof existing.id === "number") {
      return { created: false, userId: existing.id };
    }
    const userId = await this.registerLocalUser({
      username: input.username,
      displayName: input.displayName,
      role: "administrator",
      passwordHash: input.temporaryPasswordHash,
      salt: input.salt,
      iterations: input.iterations,
      mustResetPassword: true,
      allowRoleOverride: true,
    });
    return { created: true, userId };
  }

  public async listAgendaItems(meetingId: number): Promise<Array<MeetingAgendaItemRecord & { id: number }>> {
    const auth = assertPermission("read", "meeting_agenda_items");
    const scopedUserId = scopeUserId(auth);
    return db.meeting_agenda_items
      .where("meetingId")
      .equals(meetingId)
      .sortBy("orderIndex")
      .then((rows) => (typeof scopedUserId === "number" ? rows.filter((row) => row.scopeUserId === scopedUserId) : rows))
      .then((rows) => rows.filter((row): row is MeetingAgendaItemRecord & { id: number } => typeof row.id === "number"));
  }

  public async saveAgendaItem(item: Omit<MeetingAgendaItemRecord, "id" | "createdAt"> & { id?: number }): Promise<number> {
    const auth = assertPermission("write", "meeting_agenda_items");
    return db
      .transaction("rw", db.meeting_agenda_items, db.audit_log, async () => {
        const before = item.id ? await db.meeting_agenda_items.get(item.id) : null;
        const payload = { ...item, scopeUserId: scopeUserId(auth), createdAt: before?.createdAt ?? now() };
        const id = item.id ? await db.meeting_agenda_items.put(payload) : await db.meeting_agenda_items.add(payload);
        const after = await db.meeting_agenda_items.get(id);
        await appendAuditOrThrow(auth, {
          action: item.id ? "agenda.updated" : "agenda.created",
          entity: "meeting_agenda_items",
          entityId: String(id),
          before: snapshot(before),
          after: snapshot(after),
          details: { meetingId: item.meetingId },
          timestamp: now(),
        });
        return id;
      });
  }

  public async listResolutions(meetingId: number): Promise<Array<MeetingResolutionRecord & { id: number }>> {
    const auth = assertPermission("read", "meeting_resolutions");
    const scopedUserId = scopeUserId(auth);
    return db.meeting_resolutions
      .where("meetingId")
      .equals(meetingId)
      .reverse()
      .sortBy("createdAt")
      .then((rows) => (typeof scopedUserId === "number" ? rows.filter((row) => row.scopeUserId === scopedUserId) : rows))
      .then((rows) => rows.filter((row): row is MeetingResolutionRecord & { id: number } => typeof row.id === "number"));
  }

  public async saveResolution(item: Omit<MeetingResolutionRecord, "id" | "createdAt"> & { id?: number }): Promise<number> {
    const auth = assertPermission("write", "meeting_resolutions");
    return db
      .transaction("rw", db.meeting_resolutions, db.audit_log, async () => {
        const before = item.id ? await db.meeting_resolutions.get(item.id) : null;
        const payload = { ...item, scopeUserId: scopeUserId(auth), createdAt: before?.createdAt ?? now() };
        const id = item.id ? await db.meeting_resolutions.put(payload) : await db.meeting_resolutions.add(payload);
        const after = await db.meeting_resolutions.get(id);

        if (payload.approved) {
          eventPublisher("meeting.resolution.approved", {
            resolutionId: id,
            meetingId: payload.meetingId,
            approvedAt: now(),
          });
        }

        await appendAuditOrThrow(auth, {
          action: item.id ? "resolution.updated" : "resolution.created",
          entity: "meeting_resolutions",
          entityId: String(id),
          before: snapshot(before),
          after: snapshot(after),
          details: { approved: payload.approved },
          timestamp: now(),
        });
        return id;
      });
  }

  public async markResolutionCompleted(resolutionId: number): Promise<void> {
    const auth = assertPermission("write", "meeting_resolutions");
    await db.transaction("rw", db.meeting_resolutions, db.audit_log, async () => {
      const before = await db.meeting_resolutions.get(resolutionId);
      if (!before) {
        throw new WOGCError({
          code: "RESOLUTION_404",
          message: "Resolution not found",
          context: { resolutionId },
          retryable: false,
        });
      }
      const after = { ...before, voteOutcome: "approved" as const };
      await db.meeting_resolutions.update(resolutionId, { voteOutcome: "approved" });
      await appendAuditOrThrow(auth, {
        action: "resolution.completed",
        entity: "meeting_resolutions",
        entityId: String(resolutionId),
        before: snapshot(before),
        after: snapshot(after),
        details: {},
        timestamp: now(),
      });
      eventPublisher("meeting.resolution.completed", {
        resolutionId,
        completedAt: now(),
      });
    });
  }

  public async saveAttachment(input: Omit<MeetingAttachmentRecord, "id" | "uploadedAt">): Promise<number> {
    const auth = assertPermission("write", "meeting_attachments");
    const fiftyMB = 50 * 1024 * 1024;
    if (input.size > fiftyMB) {
      throw new WOGCError({
        code: "ATTACHMENT_TOO_LARGE",
        message: "Attachment exceeds 50MB limit",
        context: { size: input.size, limit: fiftyMB },
        retryable: false,
      });
    }
    return db
      .transaction("rw", db.meeting_attachments, db.audit_log, async () => {
        const id = await db.meeting_attachments.add({
          ...input,
          scopeUserId: scopeUserId(auth),
          uploadedAt: now(),
        });
        await appendAuditOrThrow(auth, {
          action: "attachment.created",
          entity: "meeting_attachments",
          entityId: String(id),
          before: null,
          after: snapshot(input),
          details: { meetingId: input.meetingId, mimeType: input.mimeType },
          timestamp: now(),
        });
        return id;
      });
  }

  public async listAttachments(meetingId: number): Promise<Array<MeetingAttachmentRecord & { id: number }>> {
    const auth = assertPermission("read", "meeting_attachments");
    const scopedUserId = scopeUserId(auth);
    return db.meeting_attachments
      .where("meetingId")
      .equals(meetingId)
      .toArray()
      .then((rows) => {
        if (auth.role === "administrator" || auth.role === "auditor") {
          return rows;
        }
        return typeof scopedUserId === "number" ? rows.filter((row) => row.scopeUserId === scopedUserId) : [];
      })
      .then((rows) => rows.filter((row): row is MeetingAttachmentRecord & { id: number } => typeof row.id === "number"));
  }

  public async getAttachmentBlob(attachmentId: number): Promise<{ filename: string; mimeType: MeetingAttachmentRecord["mimeType"]; blobData: Blob } | null> {
    const auth = assertPermission("read", "meeting_attachments");
    const row = await db.meeting_attachments.get(attachmentId);
    if (!row) {
      return null;
    }
    if (auth.role === "administrator" || auth.role === "auditor") {
      if (!row.blobData) {
        return null;
      }
      return {
        filename: row.filename,
        mimeType: row.mimeType,
        blobData: row.blobData,
      };
    }
    if (typeof scopeUserId(auth) === "number" && row.scopeUserId !== scopeUserId(auth)) {
      throw new WOGCError({
        code: "AUTH_403",
        message: "Attachment access denied",
        context: { attachmentId },
        retryable: false,
      });
    }
    if (!row.blobData) {
      return null;
    }
    return {
      filename: row.filename,
      mimeType: row.mimeType,
      blobData: row.blobData,
    };
  }

  public async saveDLQEntry(input: {
    eventPayload: WOGCEventEnvelope;
    errorContract: { code: string; message: string; context?: Record<string, unknown>; retryable: boolean };
    retryCount: number;
    status?: "pending" | "replayed" | "archived";
  }): Promise<number> {
    return db.dead_letter_queue.add({
      eventPayload: input.eventPayload,
      errorContract: {
        code: input.errorContract.code,
        message: input.errorContract.message,
        context: input.errorContract.context ?? {},
        retryable: input.errorContract.retryable,
      },
      failedAt: now(),
      retryCount: input.retryCount,
      status: input.status ?? "pending",
    });
  }

  public async listDLQEntries(status?: "pending" | "replayed" | "archived"): Promise<DLQEntry[]> {
    const auth = assertPermission("read", "dead_letter_queue");
    if (auth.role !== "administrator" && auth.role !== "auditor") {
      throw new WOGCError({
        code: "AUTH_403",
        message: "DLQ access denied",
        context: { role: auth.role },
        retryable: false,
      });
    }
    const rows = await db.dead_letter_queue.orderBy("failedAt").reverse().toArray();
    return rows
      .filter((row) => (status ? row.status === status : true))
      .filter((row): row is DLQEntry => typeof row.id === "number");
  }

  public async getDLQEntryById(dlqId: number): Promise<DLQEntry | null> {
    const auth = assertPermission("read", "dead_letter_queue");
    if (auth.role !== "administrator" && auth.role !== "auditor") {
      throw new WOGCError({
        code: "AUTH_403",
        message: "DLQ read denied",
        context: { role: auth.role, dlqId },
        retryable: false,
      });
    }
    const row = await db.dead_letter_queue.get(dlqId);
    if (!row || typeof row.id !== "number") {
      return null;
    }
    return row as DLQEntry;
  }

  public async retryDLQItem(dlqId: number, actingRole: string): Promise<DLQEntry | null> {
    if (actingRole === "Auditor") throw new Error("DAL Unauthorized: Auditors have read-only access");
    if (actingRole !== "Administrator") throw new Error("DAL Unauthorized: Only Administrators can mutate DLQ status");
    assertMutationRole(actingRole);
    const row = await this.getDLQEntryById(dlqId);
    if (!row) {
      return null;
    }
    await this.updateDLQStatus(dlqId, "replayed", actingRole);
    return this.getDLQEntryById(dlqId);
  }

  public async updateDLQStatus(dlqId: number, status: "pending" | "replayed" | "archived", actingRole: string): Promise<void> {
    if (actingRole === "Auditor") throw new Error("DAL Unauthorized: Auditors have read-only access");
    if (actingRole !== "Administrator") throw new Error("DAL Unauthorized: Only Administrators can mutate DLQ status");
    assertMutationRole(actingRole);
    const auth = assertPermission("read", "dead_letter_queue");
    if (auth.role !== "administrator") {
      throw new WOGCError({
        code: "AUTH_403",
        message: "DLQ status update denied",
        context: { role: auth.role, dlqId },
        retryable: false,
      });
    }
    await db.dead_letter_queue.update(dlqId, { status });
  }

  public async resolveUserIdsByUsernames(usernames: string[]): Promise<number[]> {
    assertPermission("read", "meetings");
    const normalized = usernames.map((item) => item.trim()).filter(Boolean);
    if (normalized.length === 0) {
      return [];
    }
    const rows = await db.users.where("username").anyOf(normalized).toArray();
    return rows.filter((row): row is UserRecord & { id: number } => typeof row.id === "number").map((row) => row.id);
  }

  public async listSubscriptions(userId: number, options?: { bypassAuth?: boolean }): Promise<Array<UserSubscriptionRecord & { id: number }>> {
    const auth = options?.bypassAuth ? systemAuth : assertPermission("read", "user_subscriptions");
    if (!options?.bypassAuth && auth.role !== "administrator" && auth.userId !== userId) {
      throw new WOGCError({
        code: "AUTH_403",
        message: "Cannot read subscriptions for another user",
        context: { userId },
        retryable: false,
      });
    }
    return db.user_subscriptions
      .where("userId")
      .equals(userId)
      .toArray()
      .then((rows) => rows.filter((row) => (row.workspaceId ?? WORKSPACE_ID) === WORKSPACE_ID))
      .then((rows) => rows.filter((row): row is UserSubscriptionRecord & { id: number } => typeof row.id === "number"));
  }

  public async getSubscriptionById(subscriptionId: number): Promise<(UserSubscriptionRecord & { id: number }) | null> {
    const auth = assertPermission("read", "user_subscriptions");
    const row = await db.user_subscriptions.get(subscriptionId);
    if (!row || typeof row.id !== "number") {
      return null;
    }
    if (auth.role !== "administrator" && auth.role !== "auditor" && auth.userId !== row.userId) {
      throw new WOGCError({
        code: "AUTH_403",
        message: "Subscription access denied",
        context: { subscriptionId },
        retryable: false,
      });
    }
    return row as UserSubscriptionRecord & { id: number };
  }

  public async upsertSubscription(input: Omit<UserSubscriptionRecord, "id" | "updatedAt">): Promise<number> {
    const auth = assertPermission("write", "user_subscriptions");
    if (auth.role !== "administrator" && auth.userId !== input.userId) {
      throw new WOGCError({
        code: "AUTH_403",
        message: "Cannot update subscriptions for another user",
        context: { userId: input.userId },
        retryable: false,
      });
    }
    return db
      .transaction("rw", db.user_subscriptions, db.audit_log, async () => {
        const existing = await db.user_subscriptions
          .where("userId")
          .equals(input.userId)
          .and((row) => row.category === input.category)
          .first();
        const payload = { ...input, workspaceId: WORKSPACE_ID, updatedAt: now() };
        const id = existing?.id ? await db.user_subscriptions.put({ ...payload, id: existing.id }) : await db.user_subscriptions.add(payload);
        await appendAuditOrThrow(auth, {
          action: "subscription.upserted",
          entity: "user_subscriptions",
          entityId: String(id),
          before: snapshot(existing),
          after: snapshot(payload),
          details: {},
          timestamp: now(),
        });
        return id;
      });
  }

  public async deleteSubscription(subscriptionId: number): Promise<void> {
    const auth = assertPermission("write", "user_subscriptions");
    const row = await db.user_subscriptions.get(subscriptionId);
    if (!row) {
      return;
    }
    if (auth.role !== "administrator" && auth.role !== "auditor" && auth.userId !== row.userId) {
      throw new WOGCError({
        code: "AUTH_403",
        message: "Subscription delete denied",
        context: { subscriptionId },
        retryable: false,
      });
    }
    await db.transaction("rw", db.user_subscriptions, db.audit_log, async () => {
      await db.user_subscriptions.delete(subscriptionId);
      await appendAuditOrThrow(auth, {
        action: "subscription.deleted",
        entity: "user_subscriptions",
        entityId: String(subscriptionId),
        before: snapshot(row),
        after: null,
        details: {},
        timestamp: now(),
      });
    });
  }

  public async setUserQuietHours(userId: number, quietHoursStart?: string, quietHoursEnd?: string): Promise<void> {
    const auth = assertPermission("write", "user_subscriptions");
    if (auth.role !== "administrator" && auth.userId !== userId) {
      throw new WOGCError({
        code: "AUTH_403",
        message: "Cannot update quiet hours for another user",
        context: { userId },
        retryable: false,
      });
    }
    const categories: NotificationRecord["category"][] = ["task_assignment", "equipment_alert", "meeting_reminder", "system"];
    await db.transaction("rw", db.user_subscriptions, db.audit_log, async () => {
      for (const category of categories) {
        const existing = await db.user_subscriptions.where("userId").equals(userId).and((row) => row.category === category).first();
        const payload = {
          userId,
          category,
          enabled: existing ? existing.enabled : true,
          quietHoursStart,
          quietHoursEnd,
          workspaceId: WORKSPACE_ID,
          updatedAt: now(),
        };
        if (existing?.id) {
          await db.user_subscriptions.put({ ...payload, id: existing.id });
        } else {
          await db.user_subscriptions.add(payload);
        }
      }
      await appendAuditOrThrow(auth, {
        action: "subscription.quiet_hours_updated",
        entity: "user_subscriptions",
        entityId: String(userId),
        before: null,
        after: { quietHoursStart: quietHoursStart ?? null, quietHoursEnd: quietHoursEnd ?? null },
        details: { userId },
        timestamp: now(),
      });
    });
  }

  public async markNotificationRead(notificationId: number, userId: number): Promise<void> {
    const auth = assertPermission("write", "notification_read_receipts");
    if (auth.role !== "administrator" && auth.userId !== userId) {
      throw new WOGCError({
        code: "AUTH_403",
        message: "Cannot mark another user's notifications",
        context: { userId },
        retryable: false,
      });
    }
    await db.transaction("rw", db.notification_read_receipts, db.notification_delivery_logs, db.audit_log, async () => {
      const existing = await db.notification_read_receipts
        .where("notificationId")
        .equals(notificationId)
        .and((row) => row.userId === userId)
        .first();
      if (!existing) {
        await db.notification_read_receipts.add({
          workspaceId: WORKSPACE_ID,
          notificationId,
          userId,
          viewedAt: now(),
        });
      }

      const logs = await db.notification_delivery_logs.where("notificationId").equals(notificationId).and((row) => row.userId === userId).toArray();
      for (const log of logs) {
        if (typeof log.id === "number") {
          await db.notification_delivery_logs.update(log.id, { read: true, readAt: now() });
        }
      }

      await appendAuditOrThrow(auth, {
        action: "notification.read",
        entity: "notification_read_receipts",
        entityId: `${notificationId}:${userId}`,
        before: null,
        after: { notificationId, userId },
        details: {},
        timestamp: now(),
      });
    });
  }

  public async deleteNotificationReadReceipt(receiptId: number): Promise<void> {
    const auth = assertPermission("write", "notification_read_receipts");
    const row = await db.notification_read_receipts.get(receiptId);
    if (!row) {
      return;
    }
    if (auth.role !== "administrator" && auth.role !== "auditor" && auth.userId !== row.userId) {
      throw new WOGCError({
        code: "AUTH_403",
        message: "Read receipt delete denied",
        context: { receiptId },
        retryable: false,
      });
    }
    await db.transaction("rw", db.notification_read_receipts, db.audit_log, async () => {
      await db.notification_read_receipts.delete(receiptId);
      await appendAuditOrThrow(auth, {
        action: "notification.read_receipt_deleted",
        entity: "notification_read_receipts",
        entityId: String(receiptId),
        before: snapshot(row),
        after: null,
        details: {},
        timestamp: now(),
      });
    });
  }

  public async deleteAttachment(attachmentId: number): Promise<void> {
    const auth = assertPermission("write", "meeting_attachments");
    const row = await db.meeting_attachments.get(attachmentId);
    if (!row) {
      return;
    }
    if (auth.role !== "administrator" && auth.role !== "auditor" && auth.userId !== row.scopeUserId) {
      throw new WOGCError({
        code: "AUTH_403",
        message: "Attachment delete denied",
        context: { attachmentId },
        retryable: false,
      });
    }
    await db.transaction("rw", db.meeting_attachments, db.audit_log, async () => {
      await db.meeting_attachments.delete(attachmentId);
      await appendAuditOrThrow(auth, {
        action: "attachment.deleted",
        entity: "meeting_attachments",
        entityId: String(attachmentId),
        before: snapshot(row),
        after: null,
        details: {},
        timestamp: now(),
      });
    });
  }

  public async unreadNotificationCount(userId: number): Promise<number> {
    const auth = assertPermission("read", "notifications");
    if (auth.role !== "administrator" && auth.role !== "auditor" && auth.userId !== userId) {
      throw new WOGCError({
        code: "AUTH_403",
        message: "Cannot read unread count for another user",
        context: { userId },
        retryable: false,
      });
    }
    const notifications = await db.notifications.where("userId").equals(userId).toArray();
    const seen = await db.notification_read_receipts.where("userId").equals(userId).toArray();
    const scopedNotifications = notifications.filter((row) => (row.workspaceId ?? WORKSPACE_ID) === WORKSPACE_ID);
    const scopedSeen = seen.filter((row) => (row.workspaceId ?? WORKSPACE_ID) === WORKSPACE_ID);
    const seenSet = new Set(scopedSeen.map((item) => item.notificationId));
    return scopedNotifications.filter((row) => typeof row.id === "number" && !seenSet.has(row.id)).length;
  }

  public async saveDeliveryLog(input: Omit<NotificationDeliveryLogRecord, "id" | "deliveredAt" | "read"> & { read?: boolean }, options?: { bypassAuth?: boolean }): Promise<number> {
    const auth = options?.bypassAuth ? systemAuth : assertPermission("write", "notification_delivery_logs");
    return db
      .transaction("rw", db.notification_delivery_logs, db.audit_log, async () => {
        const id = await db.notification_delivery_logs.add({
          ...input,
          workspaceId: WORKSPACE_ID,
          deliveredAt: now(),
          read: input.read ?? false,
        });
        await appendAuditOrThrow(auth, {
          action: input.status === "suppressed_quiet_hours" ? "notification.suppressed" : "notification.delivered",
          entity: "notification_delivery_logs",
          entityId: String(id),
          before: null,
          after: snapshot(input),
          details: {},
          timestamp: now(),
        });
        return id;
      });
  }

  public async listDeliveryLogs(filters?: {
    userId?: number;
    eventType?: string;
    fromISO?: string;
    toISO?: string;
  }): Promise<Array<NotificationDeliveryLogRecord & { id: number }>> {
    const auth = assertPermission("read", "notification_delivery_logs");
    return db.notification_delivery_logs
      .orderBy("deliveredAt")
      .reverse()
      .filter((row) => {
        if (typeof filters?.userId === "number" && row.userId !== filters.userId) {
          return false;
        }
        if (filters?.eventType && row.eventType !== filters.eventType) {
          return false;
        }
        if (filters?.fromISO && row.deliveredAt < filters.fromISO) {
          return false;
        }
        if (filters?.toISO && row.deliveredAt > filters.toISO) {
          return false;
        }
        if ((row.workspaceId ?? WORKSPACE_ID) !== WORKSPACE_ID) {
          return false;
        }
        return true;
      })
      .toArray()
      .then((rows) => rows.filter((row): row is NotificationDeliveryLogRecord & { id: number } => typeof row.id === "number"));
  }

  public async createSession(input: Omit<SessionRecord, "id" | "createdAt" | "lastSeenAt" | "terminatedAt">): Promise<number> {
    const auth = authResolver();
    const createdAt = now();
    return db
      .transaction("rw", db.sessions, db.audit_log, async () => {
        const id = await db.sessions.add({
          ...input,
          createdAt,
          lastSeenAt: createdAt,
        });
        await appendAuditOrThrow(auth, {
          action: "session.created",
          entity: "sessions",
          entityId: String(id),
          before: null,
          after: { userId: input.userId, role: input.role },
          details: {},
          timestamp: now(),
        });
        return id;
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to create session",
          context: { userId: input.userId },
          retryable: true,
        });
      });
  }

  public async listSessions(): Promise<Array<SessionRecord & { id: number }>> {
    assertPermission("read", "sessions");
    return db.sessions
      .orderBy("createdAt")
      .reverse()
      .toArray()
      .then((rows) => rows.filter((row): row is SessionRecord & { id: number } => typeof row.id === "number"))
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_READ_FAIL",
          message: "Failed to read sessions",
          context: {},
          retryable: true,
        });
      });
  }

  public async terminateSession(sessionId: number): Promise<void> {
    const auth = assertPermission("write", "sessions");
    await db
      .transaction("rw", db.sessions, db.audit_log, async () => {
        const before = await db.sessions.get(sessionId);
        await db.sessions.update(sessionId, { terminatedAt: now(), lastSeenAt: now() });
        const after = await db.sessions.get(sessionId);
        await appendAuditOrThrow(auth, {
          action: "session.terminated",
          entity: "sessions",
          entityId: String(sessionId),
          before: snapshot(before),
          after: snapshot(after),
          details: {},
          timestamp: now(),
        });
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to terminate session",
          context: { sessionId },
          retryable: true,
        });
      });
  }

  public async listSystemSettings(): Promise<Array<SystemSettingRecord & { id: number }>> {
    assertPermission("read", "system_settings");
    return db.system_settings.toArray().then((rows) => rows.filter((row): row is SystemSettingRecord & { id: number } => typeof row.id === "number"));
  }

  public async saveSystemSetting(input: Omit<SystemSettingRecord, "id" | "updatedAt">): Promise<number> {
    const auth = assertPermission("write", "system_settings");
    return db
      .transaction("rw", db.system_settings, db.audit_log, async () => {
        const previous = await db.system_settings.where("key").equals(input.key).first();
        const payload = { ...input, updatedAt: now() };
        const id = previous?.id ? await db.system_settings.put({ ...payload, id: previous.id }) : await db.system_settings.add(payload);
        await appendAuditOrThrow(auth, {
          action: "setting.upserted",
          entity: "system_settings",
          entityId: String(id),
          before: snapshot(previous),
          after: snapshot(payload),
          details: { key: input.key },
          timestamp: now(),
        });
        return id;
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to save setting",
          context: { key: input.key },
          retryable: true,
        });
      });
  }

  public async getPublicConfig(): Promise<RuntimeConfig> {
    const rows = await db.system_settings.where("key").equals("runtime.config.v1").first();
    if (!rows) {
      return DEFAULT_RUNTIME_CONFIG;
    }
    try {
      const parsed = JSON.parse(rows.value) as Partial<RuntimeConfig>;
      return {
        ...DEFAULT_RUNTIME_CONFIG,
        ...parsed,
        conflictRules: {
          ...DEFAULT_RUNTIME_CONFIG.conflictRules,
          ...(parsed.conflictRules ?? {}),
        },
      };
    } catch {
      return DEFAULT_RUNTIME_CONFIG;
    }
  }

  public async getOperationalSettings(): Promise<Array<SystemSettingRecord & { id: number }>> {
    assertPermission("read", "system_settings");
    return db.system_settings
      .toArray()
      .then((rows) => rows.filter((row): row is SystemSettingRecord & { id: number } => typeof row.id === "number"));
  }

  public async getRuntimeConfig(): Promise<RuntimeConfig> {
    return this.getPublicConfig();
  }

  public async importRuntimeConfig(jsonText: string): Promise<RuntimeConfig> {
    const auth = assertPermission("write", "system_settings");
    let parsed: RuntimeConfig;
    try {
      parsed = JSON.parse(jsonText) as RuntimeConfig;
    } catch {
      throw new WOGCError({
        code: "CONFIG_INVALID_JSON",
        message: "Configuration file is not valid JSON",
        context: {},
        retryable: false,
      });
    }
    if (!parsed.version || parsed.version < 1) {
      throw new WOGCError({
        code: "CONFIG_VERSION_INVALID",
        message: "Configuration version is missing or invalid",
        context: { version: parsed.version },
        retryable: false,
      });
    }
    const merged: RuntimeConfig = {
      ...DEFAULT_RUNTIME_CONFIG,
      ...parsed,
      conflictRules: {
        ...DEFAULT_RUNTIME_CONFIG.conflictRules,
        ...parsed.conflictRules,
      },
    };
    await this.saveSystemSetting({ key: "runtime.config.v1", value: JSON.stringify(merged) });
    await appendAuditOrThrow(auth, {
      action: "config.imported",
      entity: "system_settings",
      entityId: "runtime.config.v1",
      before: null,
      after: snapshot(merged),
      details: { version: merged.version },
      timestamp: now(),
    });
    return merged;
  }

  public async listPermissionOverrides(): Promise<Array<PermissionOverrideRecord & { id: number }>> {
    assertPermission("read", "permission_overrides");
    return db.permission_overrides
      .toArray()
      .then((rows) => rows.filter((row): row is PermissionOverrideRecord & { id: number } => typeof row.id === "number"));
  }

  public async savePermissionOverride(input: Omit<PermissionOverrideRecord, "id" | "updatedAt">): Promise<number> {
    const auth = assertPermission("write", "permission_overrides");
    return db
      .transaction("rw", db.permission_overrides, db.audit_log, async () => {
        const existing = await db.permission_overrides.where("role").equals(input.role).and((row) => row.scope === input.scope).first();
        const payload = { ...input, updatedAt: now() };
        const id = existing?.id ? await db.permission_overrides.put({ ...payload, id: existing.id }) : await db.permission_overrides.add(payload);
        await appendAuditOrThrow(auth, {
          action: "permission_override.upserted",
          entity: "permission_overrides",
          entityId: String(id),
          before: snapshot(existing),
          after: snapshot(payload),
          details: { role: input.role, scope: input.scope },
          timestamp: now(),
        });
        return id;
      })
      .catch((error) => {
        throw ensureWOGCError(error, {
          code: "DB_WRITE_FAIL",
          message: "Failed to save permission override",
          context: { role: input.role, scope: input.scope },
          retryable: true,
        });
      });
  }

  public async listWarehouseSites(): Promise<Array<WarehouseSiteRecord & { id: number }>> {
    assertPermission("read", "warehouse_sites");
    return db.warehouse_sites
      .orderBy("updatedAt")
      .reverse()
      .toArray()
      .then((rows) => rows.filter((row): row is WarehouseSiteRecord & { id: number } => typeof row.id === "number"));
  }

  public async saveWarehouseSite(input: Omit<WarehouseSiteRecord, "id" | "createdAt" | "updatedAt"> & { id?: number }): Promise<number> {
    const auth = assertPermission("write", "warehouse_sites");
    const code = normalizeAdminKey(validateRequired(input.code, "SITE_CODE_REQUIRED", "Site code is required", "code"));
    const name = validateRequired(input.name, "SITE_NAME_REQUIRED", "Site name is required", "name");
    const timezone = validateRequired(input.timezone, "SITE_TIMEZONE_REQUIRED", "Timezone is required", "timezone");
    return db.transaction("rw", db.warehouse_sites, db.audit_log, async () => {
      const before = input.id ? await db.warehouse_sites.get(input.id) : null;
      const duplicate = await db.warehouse_sites.where("code").equals(code).first();
      if (duplicate?.id && duplicate.id !== input.id) {
        throw new WOGCError({
          code: "SITE_CODE_DUPLICATE",
          message: "A site with this code already exists",
          context: { code },
          retryable: false,
        });
      }
      const payload: WarehouseSiteRecord = {
        code,
        name,
        timezone,
        active: input.active,
        createdAt: before?.createdAt ?? now(),
        updatedAt: now(),
      };
      const id = input.id ? await db.warehouse_sites.put({ ...payload, id: input.id }) : await db.warehouse_sites.add(payload);
      await appendAuditOrThrow(auth, {
        action: input.id ? "site.updated" : "site.created",
        entity: "warehouse_sites",
        entityId: String(id),
        before: snapshot(before),
        after: snapshot(payload),
        details: { code },
        timestamp: now(),
      });
      return id;
    }).catch((error) => {
      if (error instanceof WOGCError) {
        throw error;
      }
      throw ensureWOGCError(error, {
        code: "DB_WRITE_FAIL",
        message: "Failed to save warehouse site",
        context: { code },
        retryable: true,
      });
    });
  }

  public async deleteWarehouseSite(siteId: number): Promise<void> {
    const auth = assertPermission("write", "warehouse_sites");
    await db.transaction("rw", db.warehouse_sites, db.audit_log, async () => {
      const before = await db.warehouse_sites.get(siteId);
      if (!before) {
        throw new WOGCError({
          code: "SITE_404",
          message: "Warehouse site not found",
          context: { siteId },
          retryable: false,
        });
      }
      await db.warehouse_sites.delete(siteId);
      await appendAuditOrThrow(auth, {
        action: "site.deleted",
        entity: "warehouse_sites",
        entityId: String(siteId),
        before: snapshot(before),
        after: null,
        details: { code: before.code },
        timestamp: now(),
      });
    });
  }

  public async listEquipmentAdapters(): Promise<Array<EquipmentAdapterRecord & { id: number }>> {
    assertPermission("read", "equipment_adapters");
    return db.equipment_adapters
      .orderBy("updatedAt")
      .reverse()
      .toArray()
      .then((rows) => rows.filter((row): row is EquipmentAdapterRecord & { id: number } => typeof row.id === "number"));
  }

  public async saveEquipmentAdapter(input: Omit<EquipmentAdapterRecord, "id" | "createdAt" | "updatedAt"> & { id?: number }): Promise<number> {
    const auth = assertPermission("write", "equipment_adapters");
    const adapterKey = normalizeAdminKey(validateRequired(input.adapterKey, "ADAPTER_KEY_REQUIRED", "Adapter key is required", "adapterKey"));
    const displayName = validateRequired(input.displayName, "ADAPTER_NAME_REQUIRED", "Adapter display name is required", "displayName");
    const endpoint = validateRequired(input.endpoint, "ADAPTER_ENDPOINT_REQUIRED", "Adapter endpoint is required", "endpoint");
    return db.transaction("rw", db.equipment_adapters, db.audit_log, async () => {
      const before = input.id ? await db.equipment_adapters.get(input.id) : null;
      const duplicate = await db.equipment_adapters.where("adapterKey").equals(adapterKey).first();
      if (duplicate?.id && duplicate.id !== input.id) {
        throw new WOGCError({
          code: "ADAPTER_KEY_DUPLICATE",
          message: "An adapter with this key already exists",
          context: { adapterKey },
          retryable: false,
        });
      }
      const payload: EquipmentAdapterRecord = {
        adapterKey,
        displayName,
        protocol: input.protocol,
        endpoint,
        active: input.active,
        createdAt: before?.createdAt ?? now(),
        updatedAt: now(),
      };
      const id = input.id ? await db.equipment_adapters.put({ ...payload, id: input.id }) : await db.equipment_adapters.add(payload);
      await appendAuditOrThrow(auth, {
        action: input.id ? "equipment_adapter.updated" : "equipment_adapter.created",
        entity: "equipment_adapters",
        entityId: String(id),
        before: snapshot(before),
        after: snapshot(payload),
        details: { adapterKey },
        timestamp: now(),
      });
      return id;
    }).catch((error) => {
      if (error instanceof WOGCError) {
        throw error;
      }
      throw ensureWOGCError(error, {
        code: "DB_WRITE_FAIL",
        message: "Failed to save equipment adapter",
        context: { adapterKey },
        retryable: true,
      });
    });
  }

  public async deleteEquipmentAdapter(adapterId: number): Promise<void> {
    const auth = assertPermission("write", "equipment_adapters");
    await db.transaction("rw", db.equipment_adapters, db.audit_log, async () => {
      const before = await db.equipment_adapters.get(adapterId);
      if (!before) {
        throw new WOGCError({
          code: "ADAPTER_404",
          message: "Equipment adapter not found",
          context: { adapterId },
          retryable: false,
        });
      }
      await db.equipment_adapters.delete(adapterId);
      await appendAuditOrThrow(auth, {
        action: "equipment_adapter.deleted",
        entity: "equipment_adapters",
        entityId: String(adapterId),
        before: snapshot(before),
        after: null,
        details: { adapterKey: before.adapterKey },
        timestamp: now(),
      });
    });
  }

  public async listOperationalTemplates(): Promise<Array<OperationalTemplateRecord & { id: number }>> {
    assertPermission("read", "operational_templates");
    return db.operational_templates
      .orderBy("updatedAt")
      .reverse()
      .toArray()
      .then((rows) => rows.filter((row): row is OperationalTemplateRecord & { id: number } => typeof row.id === "number"));
  }

  public async saveOperationalTemplate(input: Omit<OperationalTemplateRecord, "id" | "createdAt" | "updatedAt"> & { id?: number }): Promise<number> {
    const auth = assertPermission("write", "operational_templates");
    const templateKey = normalizeAdminKey(validateRequired(input.templateKey, "TEMPLATE_KEY_REQUIRED", "Template key is required", "templateKey"));
    const name = validateRequired(input.name, "TEMPLATE_NAME_REQUIRED", "Template name is required", "name");
    const content = validateRequired(input.content, "TEMPLATE_CONTENT_REQUIRED", "Template content is required", "content");
    if (!validWorkstreams.includes(input.workstream)) {
      throw new WOGCError({
        code: "TEMPLATE_WORKSTREAM_INVALID",
        message: "Template workstream is invalid",
        context: { workstream: input.workstream },
        retryable: false,
      });
    }
    return db.transaction("rw", db.operational_templates, db.audit_log, async () => {
      const before = input.id ? await db.operational_templates.get(input.id) : null;
      const duplicate = await db.operational_templates.where("templateKey").equals(templateKey).first();
      if (duplicate?.id && duplicate.id !== input.id) {
        throw new WOGCError({
          code: "TEMPLATE_KEY_DUPLICATE",
          message: "A template with this key already exists",
          context: { templateKey },
          retryable: false,
        });
      }
      const payload: OperationalTemplateRecord = {
        templateKey,
        name,
        workstream: input.workstream,
        content,
        active: input.active,
        createdAt: before?.createdAt ?? now(),
        updatedAt: now(),
      };
      const id = input.id ? await db.operational_templates.put({ ...payload, id: input.id }) : await db.operational_templates.add(payload);
      await appendAuditOrThrow(auth, {
        action: input.id ? "template.updated" : "template.created",
        entity: "operational_templates",
        entityId: String(id),
        before: snapshot(before),
        after: snapshot(payload),
        details: { templateKey, workstream: input.workstream },
        timestamp: now(),
      });
      return id;
    }).catch((error) => {
      if (error instanceof WOGCError) {
        throw error;
      }
      throw ensureWOGCError(error, {
        code: "DB_WRITE_FAIL",
        message: "Failed to save operational template",
        context: { templateKey },
        retryable: true,
      });
    });
  }

  public async deleteOperationalTemplate(templateId: number): Promise<void> {
    const auth = assertPermission("write", "operational_templates");
    await db.transaction("rw", db.operational_templates, db.audit_log, async () => {
      const before = await db.operational_templates.get(templateId);
      if (!before) {
        throw new WOGCError({
          code: "TEMPLATE_404",
          message: "Operational template not found",
          context: { templateId },
          retryable: false,
        });
      }
      await db.operational_templates.delete(templateId);
      await appendAuditOrThrow(auth, {
        action: "template.deleted",
        entity: "operational_templates",
        entityId: String(templateId),
        before: snapshot(before),
        after: null,
        details: { templateKey: before.templateKey },
        timestamp: now(),
      });
    });
  }

  public async listAuditTrail(filters?: {
    fromISO?: string;
    toISO?: string;
    entity?: string;
    actorUsername?: string;
  }): Promise<Array<AuditLogRecord & { id: number }>> {
    assertPermission("read", "audit_log");
    return db.audit_log
      .orderBy("sequence")
      .reverse()
      .filter((row) => {
        if (filters?.fromISO && row.timestamp < filters.fromISO) {
          return false;
        }
        if (filters?.toISO && row.timestamp > filters.toISO) {
          return false;
        }
        if (filters?.entity && row.entity !== filters.entity) {
          return false;
        }
        if (filters?.actorUsername && row.actorUsername !== filters.actorUsername) {
          return false;
        }
        return true;
      })
      .toArray()
      .then((rows) => rows.filter((row): row is AuditLogRecord & { id: number } => typeof row.id === "number"));
  }
}

const dalTarget = new DAL();

export const dal = new Proxy(dalTarget, {
  get(target, prop, receiver) {
    if (!(prop in target)) {
      throw new WOGCError({
        code: "DAL_UNKNOWN_OP",
        message: `Unknown DAL operation: ${String(prop)}`,
        context: { prop: String(prop) },
        retryable: false,
      });
    }
    return Reflect.get(target, prop, receiver);
  },
});

export const setDALAuthResolver = (resolver: () => AuthSnapshot): void => {
  authResolver = resolver;
};

export const setDALEventPublisher = (
  publisher: <T extends WOGCEventType>(type: T, payload: WOGCEventPayloadMap[T]) => void,
): void => {
  eventPublisher = publisher;
};

export const closeDALConnections = (): void => {
  db.close();
};
