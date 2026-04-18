import { useDispatch } from "react-redux";
import type { AppDispatch, ToastVariant } from "../store";
import { uiActions } from "../store";
import { WOGCError } from "../utils/errors";

const roleHintByTable: Record<string, string> = {
  tasks: "Tasks can only be changed by Dispatchers and Administrators.",
  users: "User administration is restricted to Administrators.",
  audit_log: "Audit trail access is restricted to Auditors and Administrators.",
  equipment_heartbeats: "Equipment controls are restricted to Dispatchers and Administrators.",
  system_settings: "System settings are restricted to Administrators.",
};

const defaultDuration: Record<ToastVariant, number> = {
  success: 3000,
  error: 5000,
  warning: 5000,
  info: 4000,
  "permission-error": 6000,
};

export const useToast = () => {
  const dispatch = useDispatch<AppDispatch>();

  const push = (variant: ToastVariant, message: string, options?: {
    durationMs?: number;
    undo?: {
      label: string;
      actionType: string;
      payload?: unknown;
    };
  }): void => {
    dispatch(uiActions.enqueueToast({
      variant,
      message,
      durationMs: options?.durationMs ?? defaultDuration[variant],
      undo: options?.undo,
    }));
  };

  const fromError = (error: unknown, fallback: string): void => {
    if (error instanceof WOGCError && error.code === "AUTH_403") {
      const table = typeof error.context?.table === "string" ? error.context.table : undefined;
      const operation = typeof error.context?.operation === "string" ? error.context.operation : "perform this action";
      const reason = table ? roleHintByTable[table] ?? `Access to ${table} is restricted by your role.` : "Your role does not grant this operation.";
      push("permission-error", `You don't have permission to ${operation}. ${reason} Contact your administrator if you need this capability.`);
      return;
    }
    if (error instanceof WOGCError) {
      push("error", `${error.code}: ${error.message}`);
      return;
    }
    push("error", fallback);
  };

  return {
    push,
    fromError,
    success: (message: string): void => push("success", message),
    error: (message: string): void => push("error", message),
    warning: (message: string): void => push("warning", message),
    info: (message: string): void => push("info", message),
    permissionError: (message: string): void => push("permission-error", message),
  };
};
