import type { UserRole } from "../db/schema";

export const privilegedVisibilityRoles: UserRole[] = ["administrator", "dispatcher", "facilitator"];

export const roleHomeRoute: Record<UserRole, string> = {
  administrator: "/admin",
  dispatcher: "/dispatcher",
  facilitator: "/meetings",
  operator: "/queue",
  viewer: "/queue",
  auditor: "/auditor",
};

export const canViewUnmasked = (role: UserRole | null): boolean => {
  if (!role) {
    return false;
  }
  return privilegedVisibilityRoles.includes(role);
};
