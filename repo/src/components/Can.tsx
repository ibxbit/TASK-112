import type { ReactNode } from "react";
import { usePermissions } from "../hooks/usePermissions";
import type { Permission } from "../config/permissions";

type CanProps = {
  permission: Permission;
  fallback?: ReactNode;
  children: ReactNode;
};

export default function Can({ permission, fallback = null, children }: CanProps): JSX.Element {
  const { can } = usePermissions();
  return <>{can(permission) ? children : fallback}</>;
}
