import { useMemo } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../store";
import type { Permission } from "../config/permissions";
import { hasPermission } from "../config/permissions";

export const usePermissions = () => {
  const role = useSelector((state: RootState) => state.auth.role);

  return useMemo(() => {
    const can = (permission: Permission): boolean => hasPermission(role, permission);
    const cannot = (permission: Permission): boolean => !can(permission);
    const canAny = (permissions: Permission[]): boolean => permissions.some((permission) => can(permission));
    const canAll = (permissions: Permission[]): boolean => permissions.every((permission) => can(permission));
    const hasRole = (targetRole: typeof role): boolean => role === targetRole;

    return {
      role,
      can,
      cannot,
      canAny,
      canAll,
      hasRole,
    };
  }, [role]);
};
