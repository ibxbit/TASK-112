import { configureStore, createSlice, type Middleware, type PayloadAction } from "@reduxjs/toolkit";
import authReducer, { idleLock, logout, roleChanged, syncBootPreferences } from "./authSlice";
import { dal, setDALAuthResolver } from "../db/dal";
import { setDLQCurrentUserResolver } from "../services/dlqService";
import { ensureWOGCError, type WOGCErrorInput } from "../utils/errors";
import { readBootLocalStorageConfig, setLastSitePreference, setThemePreference } from "../utils/localStorage";
import type { WOGCEventEnvelope } from "../types/events";

type UIState = {
  theme: "light" | "dark";
  lastSite: string;
  globalError: WOGCErrorInput | null;
  toasts: ToastMessage[];
};

export type ToastVariant = "success" | "error" | "warning" | "info" | "permission-error";

export type ToastMessage = {
  id: string;
  variant: ToastVariant;
  message: string;
  durationMs: number;
  undo?: {
    label: string;
    actionType: string;
    payload?: unknown;
  };
};

type EventBusState = {
  deadLetterQueue: Array<{
    id: number;
    eventPayload: WOGCEventEnvelope;
    errorContract: WOGCErrorInput;
    failedAt: string;
    retryCount: number;
    status: "pending" | "replayed" | "archived";
  }>;
};

const bootConfig = readBootLocalStorageConfig();

const uiSlice = createSlice({
  name: "ui",
  initialState: {
    theme: bootConfig.theme,
    lastSite: bootConfig.lastSite,
    globalError: null,
    toasts: [],
  } as UIState,
  reducers: {
    setTheme: (state, action: PayloadAction<"light" | "dark">) => {
      state.theme = action.payload;
      setThemePreference(action.payload);
    },
    setLastSite: (state, action: PayloadAction<string>) => {
      state.lastSite = action.payload;
      setLastSitePreference(action.payload);
    },
    setGlobalError: (state, action: PayloadAction<WOGCErrorInput | null>) => {
      state.globalError = action.payload;
    },
    enqueueToast: (state, action: PayloadAction<Omit<ToastMessage, "id"> & { id?: string }>) => {
      state.toasts.push({
        ...action.payload,
        id: action.payload.id ?? `toast_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      });
    },
    dismissToast: (state, action: PayloadAction<string>) => {
      state.toasts = state.toasts.filter((toast) => toast.id !== action.payload);
    },
  },
});

const eventBusSlice = createSlice({
  name: "eventBus",
  initialState: { deadLetterQueue: [] } as EventBusState,
  reducers: {
    setDLQ: (state, action: PayloadAction<EventBusState["deadLetterQueue"]>) => {
      state.deadLetterQueue = action.payload;
    },
  },
});

const appReducer = {
  auth: authReducer,
  ui: uiSlice.reducer,
  eventBus: eventBusSlice.reducer,
};

const errorNormalizerMiddleware: Middleware = (api) => (next) => (action: unknown) => {
  const result = next(action);

  if (typeof action === "object" && action !== null && "type" in action) {
    const actionWithType = action as { type: string; payload?: unknown; error?: unknown };
    if (actionWithType.type.endsWith("/rejected")) {
      const normalized = ensureWOGCError(actionWithType.payload ?? actionWithType.error, {
        code: "THUNK_REJECTED",
        message: "Async operation rejected",
        context: { action: actionWithType.type },
        retryable: true,
      }).toJSON();
      api.dispatch(uiSlice.actions.setGlobalError(normalized));
      if (normalized.code === "AUTH_403") {
        api.dispatch(uiSlice.actions.enqueueToast({
          variant: "permission-error",
          durationMs: 6000,
          message: "You do not have permission to perform this action. Contact your administrator.",
        }));
      }
    }
  }

  return result;
};

const bootPreferenceSyncMiddleware: Middleware = (api) => (next) => (action: unknown) => {
  const result = next(action);
  if (typeof action === "object" && action !== null && "type" in action) {
    const actionType = (action as { type: string }).type;
    if (actionType === uiSlice.actions.setTheme.type || actionType === uiSlice.actions.setLastSite.type) {
      api.dispatch(syncBootPreferences());
    }
  }
  return result;
};

let lastRoleCheckAt = 0;
const roleDriftMiddleware: Middleware = (api) => (next) => (action: unknown) => {
  const result = next(action);
  const state = api.getState() as RootState;
  if (!state.auth.isAuthenticated || !state.auth.userId || !state.auth.role) {
    return result;
  }
  const nowMs = Date.now();
  if (nowMs - lastRoleCheckAt < 3000) {
    return result;
  }
  lastRoleCheckAt = nowMs;
  void dal.getUserProfile(state.auth.userId).then((user) => {
    if (!user) {
      api.dispatch(logout());
      return;
    }
    if (user.role !== state.auth.role) {
      api.dispatch(roleChanged());
    }
  }).catch(() => undefined);
  return result;
};

export const store = configureStore({
  reducer: (state, action) => {
    if (action.type === "auth/logout" || action.type === idleLock.type || action.type === roleChanged.type) {
      return {
        auth: appReducer.auth(undefined, { type: "@@INIT" }),
        ui: appReducer.ui(undefined, { type: "@@INIT" }),
        eventBus: appReducer.eventBus(undefined, { type: "@@INIT" }),
      };
    }

    return {
      auth: appReducer.auth(state?.auth, action),
      ui: appReducer.ui(state?.ui, action),
      eventBus: appReducer.eventBus(state?.eventBus, action),
    };
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: false,
    }).concat(errorNormalizerMiddleware, bootPreferenceSyncMiddleware, roleDriftMiddleware),
});

setDALAuthResolver(() => {
  const state = store.getState();
  return {
    isAuthenticated: state.auth.isAuthenticated,
    userId: state.auth.userId,
    username: state.auth.username,
    role: state.auth.role,
  };
});

setDLQCurrentUserResolver(() => {
  const state = store.getState();
  return {
    userId: state.auth.userId,
    username: state.auth.username,
    role: state.auth.role,
  };
});

export const uiActions = uiSlice.actions;
export const eventBusActions = eventBusSlice.actions;
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
