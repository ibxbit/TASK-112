import { createAsyncThunk } from "@reduxjs/toolkit";
import { dal } from "../db/dal";
import type { UserRole } from "../db/schema";
import { WOGCError, ensureWOGCError } from "../utils/errors";
import { authService } from "../services/AuthService";

export const registerLocalUser = createAsyncThunk<
  { userId: number; username: string; displayName: string; role: UserRole },
  { username: string; displayName: string; temporaryPassword: string },
  { rejectValue: ReturnType<WOGCError["toJSON"]> }
>("auth/registerLocalUser", async (payload, thunkApi) => {
  const normalizedUsername = authService.normalizeUsername(payload.username);
  try {
    const available = await authService.ensureUsernameAvailable(normalizedUsername);
    if (!available) {
      throw new WOGCError({
        code: "AUTH_EXISTS",
        message: "User already exists",
        context: { username: normalizedUsername },
        retryable: false,
      });
    }

    const material = await authService.generateCredentialMaterial(payload.temporaryPassword);
    const userId = await dal.registerLocalUser({
      username: normalizedUsername,
      displayName: payload.displayName,
      passwordHash: material.passwordHash,
      salt: material.salt,
      iterations: material.iterations,
      role: "viewer",
      mustResetPassword: true,
    });

    return { userId, username: normalizedUsername, displayName: payload.displayName, role: "viewer" };
  } catch (error) {
    return thunkApi.rejectWithValue(
      ensureWOGCError(error, {
        code: "AUTH_REGISTER_FAIL",
        message: "Unable to register user",
        context: { username: normalizedUsername },
        retryable: false,
      }).toJSON(),
    );
  }
});

export const loginLocalUser = createAsyncThunk<
  { userId: number; username: string; displayName: string | null; role: UserRole; sessionId: number | null; mustResetPassword: boolean },
  { username: string; password: string },
  { rejectValue: ReturnType<WOGCError["toJSON"]> }
>("auth/loginLocalUser", async (payload, thunkApi) => {
  const normalizedUsername = authService.normalizeUsername(payload.username);
  try {
    const profile = await authService.authenticateUser(normalizedUsername, payload.password);

    let sessionId: number | null = null;
    try {
      sessionId = await dal.createSession({
        userId: profile.id,
        username: profile.username,
        role: profile.role,
      });
    } catch {
      sessionId = null;
    }

    return {
      userId: profile.id,
      username: profile.username,
      displayName: profile.displayName ?? null,
      role: profile.role,
      sessionId,
      mustResetPassword: Boolean(profile.mustResetPassword),
    };
  } catch (error) {
    return thunkApi.rejectWithValue(
      ensureWOGCError(error, {
        code: "AUTH_LOGIN_FAIL",
        message: "Unable to log in",
        context: { username: normalizedUsername },
        retryable: false,
      }).toJSON(),
    );
  }
});

export const resetPasswordAfterFirstLogin = createAsyncThunk<
  { userId: number },
  { userId: number; currentPassword: string; nextPassword: string },
  { rejectValue: ReturnType<WOGCError["toJSON"]> }
>("auth/resetPasswordAfterFirstLogin", async (payload, thunkApi) => {
  try {
    await authService.verifyCurrentPasswordAndRotate(payload.userId, payload.currentPassword, payload.nextPassword);
    return { userId: payload.userId };
  } catch (error) {
    return thunkApi.rejectWithValue(
      ensureWOGCError(error, {
        code: "AUTH_RESET_FAIL",
        message: "Unable to reset password",
        context: { userId: payload.userId },
        retryable: false,
      }).toJSON(),
    );
  }
});
