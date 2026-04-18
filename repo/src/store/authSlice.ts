import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { UserRole } from "../db/schema";
import { WOGCError, ensureWOGCError } from "../utils/errors";
import { readBootLocalStorageConfig, type ThemePreference } from "../utils/localStorage";
import { loginLocalUser, registerLocalUser, resetPasswordAfterFirstLogin } from "./authThunks";

export type AuthState = {
  isAuthenticated: boolean;
  userId: number | null;
  username: string | null;
  displayName: string | null;
  role: UserRole | null;
  sessionId: number | null;
  preferredTheme: ThemePreference;
  lastSite: string;
  sessionTimeoutMs: number;
  mustResetPassword: boolean;
  status: "idle" | "loading" | "authenticated";
  error: ReturnType<WOGCError["toJSON"]> | null;
};

const buildInitialState = (): AuthState => {
  const boot = readBootLocalStorageConfig();
  return {
    isAuthenticated: false,
    userId: null,
    username: null,
    displayName: null,
    role: null,
    sessionId: null,
    preferredTheme: boot.theme,
    lastSite: boot.lastSite,
    sessionTimeoutMs: boot.sessionTimeoutMs,
    mustResetPassword: false,
    status: "idle",
    error: null,
  };
};

const resetAuthState = (): AuthState => {
  const boot = readBootLocalStorageConfig();
  return {
    isAuthenticated: false,
    userId: null,
    username: null,
    displayName: null,
    role: null,
    sessionId: null,
    preferredTheme: boot.theme,
    lastSite: boot.lastSite,
    sessionTimeoutMs: boot.sessionTimeoutMs,
    mustResetPassword: false,
    status: "idle",
    error: null,
  };
};

const initialState: AuthState = buildInitialState();

const authSlice = createSlice({
  name: "auth",
  initialState,
  reducers: {
    logout: () => resetAuthState(),
    idleLock: () => resetAuthState(),
    roleChanged: () => resetAuthState(),
    setSessionTimeoutMs: (state, action: PayloadAction<number>) => {
      if (Number.isFinite(action.payload) && action.payload > 0) {
        state.sessionTimeoutMs = Math.trunc(action.payload);
      }
    },
    syncBootPreferences: (state) => {
      const boot = readBootLocalStorageConfig();
      state.preferredTheme = boot.theme;
      state.lastSite = boot.lastSite;
      state.sessionTimeoutMs = boot.sessionTimeoutMs;
    },
    clearAuthError: (state) => {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(registerLocalUser.pending, (state) => {
      state.status = "loading";
      state.error = null;
    });
    builder.addCase(registerLocalUser.fulfilled, (state, action) => {
      state.status = "idle";
      state.isAuthenticated = false;
      state.userId = action.payload.userId;
      state.username = action.payload.username;
      state.displayName = action.payload.displayName;
      state.role = action.payload.role;
      state.mustResetPassword = true;
    });
    builder.addCase(registerLocalUser.rejected, (state, action) => {
      state.status = "idle";
      state.error = ensureWOGCError(action.payload ?? action.error).toJSON();
    });

    builder.addCase(loginLocalUser.pending, (state) => {
      state.status = "loading";
      state.error = null;
    });
    builder.addCase(loginLocalUser.fulfilled, (state, action) => {
      state.status = "authenticated";
      state.isAuthenticated = true;
      state.userId = action.payload.userId;
      state.username = action.payload.username;
      state.displayName = action.payload.displayName;
      state.role = action.payload.role;
      state.sessionId = action.payload.sessionId;
      state.mustResetPassword = action.payload.mustResetPassword;
    });
    builder.addCase(loginLocalUser.rejected, (state, action) => {
      state.status = "idle";
      state.error = ensureWOGCError(action.payload ?? action.error).toJSON();
    });

    builder.addCase(resetPasswordAfterFirstLogin.pending, (state) => {
      state.status = "loading";
      state.error = null;
    });
    builder.addCase(resetPasswordAfterFirstLogin.fulfilled, (state) => {
      state.status = "authenticated";
      state.mustResetPassword = false;
    });
    builder.addCase(resetPasswordAfterFirstLogin.rejected, (state, action) => {
      state.status = "idle";
      state.error = ensureWOGCError(action.payload ?? action.error).toJSON();
    });
  },
});

export const { logout, idleLock, roleChanged, setSessionTimeoutMs, syncBootPreferences, clearAuthError } = authSlice.actions;
export default authSlice.reducer;
