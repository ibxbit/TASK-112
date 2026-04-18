import { Navigate } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { useEffect, useRef } from "react";
import type { AppDispatch, RootState } from "../store";
import { uiActions } from "../store";
import { roleHomeRoute } from "../utils/rbac";
import type { UserRole } from "../db/schema";
import type { Permission } from "../config/permissions";
import { hasPermission } from "../config/permissions";
import { dal } from "../db/dal";

type Props = {
  allowed?: UserRole[];
  permission?: Permission;
  children: JSX.Element;
};

const ForbiddenRedirect = ({ role, permission }: { role: UserRole; permission?: Permission }): JSX.Element => {
  const dispatch = useDispatch<AppDispatch>();
  const logged = useRef(false);

  useEffect(() => {
    if (logged.current) {
      return;
    }
    logged.current = true;
    dispatch(uiActions.enqueueToast({
      variant: "permission-error",
      durationMs: 6000,
      message: permission
        ? `You do not have permission for ${permission}. Contact your administrator.`
        : "You do not have permission to access this page. Contact your administrator.",
    }));
    void dal.logPermissionDeniedAttempt({
      operation: "read",
      target: permission ?? "route",
      reason: "route_guard",
    });
  }, [dispatch, permission]);

  const fallback = roleHomeRoute[role];
  return <Navigate to="/forbidden" replace state={{ from: fallback }} />;
};

export default function RoleGate({ allowed, permission, children }: Props): JSX.Element {
  const role = useSelector((state: RootState) => state.auth.role as UserRole | null);
  if (!role) {
    return <Navigate to="/login" replace />;
  }
  if (permission && !hasPermission(role, permission)) {
    return <ForbiddenRedirect role={role} permission={permission} />;
  }
  if (allowed && !allowed.includes(role)) {
    return <ForbiddenRedirect role={role} />;
  }
  return children;
}
