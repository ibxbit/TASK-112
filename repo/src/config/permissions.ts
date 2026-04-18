import type { UserRole } from "../db/schema";

export type Permission =
  | "tasks:create"
  | "tasks:read"
  | "tasks:update"
  | "tasks:delete"
  | "equipment:create"
  | "equipment:read"
  | "equipment:update"
  | "equipment:delete"
  | "equipment:command"
  | "meetings:create"
  | "meetings:read"
  | "meetings:update"
  | "meetings:delete"
  | "meetings:manage"
  | "notifications:create"
  | "notifications:read"
  | "notifications:update"
  | "notifications:delete"
  | "users:create"
  | "users:read"
  | "users:update"
  | "users:delete"
  | "audit_logs:read"
  | "audit_logs:export"
  | "audit_logs:verify"
  | "system_settings:create"
  | "system_settings:read"
  | "system_settings:update"
  | "system_settings:delete"
  | "tasks:assign"
  | "tasks:complete"
  | "tasks:comment"
  | "tasks:resolve_conflict"
  | "tasks:reclassify"
  | "calendar:read"
  | "calendar:create"
  | "calendar:reschedule"
  | "notifications:manage_settings"
  | "notifications:mark_read"
  | "notifications:delivery_logs"
  | "sites:read"
  | "sites:create"
  | "sites:update"
  | "sites:delete"
  | "equipment_adapters:read"
  | "equipment_adapters:create"
  | "equipment_adapters:update"
  | "equipment_adapters:delete"
  | "templates:read"
  | "templates:create"
  | "templates:update"
  | "templates:delete"
  | "dispatcher_dashboard:read"
  | "admin:read"
  | "audit:read"
  | "audit:export"
  | "audit:verify";

const allPermissions: Permission[] = [
  "tasks:create",
  "tasks:read",
  "tasks:update",
  "tasks:delete",
  "equipment:create",
  "equipment:read",
  "equipment:update",
  "equipment:delete",
  "equipment:command",
  "meetings:create",
  "meetings:read",
  "meetings:update",
  "meetings:delete",
  "meetings:manage",
  "notifications:create",
  "notifications:read",
  "notifications:update",
  "notifications:delete",
  "users:create",
  "users:read",
  "users:update",
  "users:delete",
  "audit_logs:read",
  "audit_logs:export",
  "audit_logs:verify",
  "system_settings:create",
  "system_settings:read",
  "system_settings:update",
  "system_settings:delete",
  "tasks:assign",
  "tasks:complete",
  "tasks:comment",
  "tasks:resolve_conflict",
  "tasks:reclassify",
  "calendar:read",
  "calendar:create",
  "calendar:reschedule",
  "notifications:manage_settings",
  "notifications:mark_read",
  "notifications:delivery_logs",
  "sites:read",
  "sites:create",
  "sites:update",
  "sites:delete",
  "equipment_adapters:read",
  "equipment_adapters:create",
  "equipment_adapters:update",
  "equipment_adapters:delete",
  "templates:read",
  "templates:create",
  "templates:update",
  "templates:delete",
  "dispatcher_dashboard:read",
  "admin:read",
  "audit:read",
  "audit:export",
  "audit:verify",
];

const rolePermissions: Record<UserRole, Set<Permission>> = {
  administrator: new Set(allPermissions),
  dispatcher: new Set([
    "tasks:create",
    "tasks:read",
    "tasks:update",
    "tasks:assign",
    "tasks:resolve_conflict",
    "tasks:reclassify",
    "equipment:read",
    "equipment:update",
    "equipment:command",
    "calendar:read",
    "calendar:create",
    "calendar:reschedule",
    "notifications:read",
    "notifications:update",
    "notifications:manage_settings",
    "notifications:mark_read",
    "notifications:delivery_logs",
    "dispatcher_dashboard:read",
  ]),
  facilitator: new Set([
    "tasks:create",
    "tasks:read",
    "tasks:update",
    "tasks:comment",
    "tasks:reclassify",
    "meetings:create",
    "meetings:read",
    "meetings:update",
    "meetings:manage",
    "calendar:read",
    "calendar:create",
    "calendar:reschedule",
    "notifications:read",
    "notifications:update",
    "notifications:manage_settings",
    "notifications:mark_read",
    "notifications:delivery_logs",
  ]),
  operator: new Set([
    "tasks:read",
    "tasks:update",
    "tasks:complete",
    "tasks:comment",
  ]),
  viewer: new Set([
    "tasks:read",
    "equipment:read",
    "meetings:read",
    "notifications:read",
    "calendar:read",
    "dispatcher_dashboard:read",
  ]),
  auditor: new Set([
    "audit_logs:read",
    "audit_logs:export",
    "audit_logs:verify",
    "audit:read",
    "audit:export",
    "audit:verify",
    "notifications:delivery_logs",
  ]),
};

export const hasPermission = (role: UserRole | null, permission: Permission): boolean => {
  if (!role) {
    return false;
  }
  const roleSet = (rolePermissions as Record<string, Set<Permission> | undefined>)[role];
  if (!roleSet) {
    return false;
  }
  return roleSet.has(permission);
};
