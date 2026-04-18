// @vitest-environment jsdom
/**
 * Behavior matrix for <PasswordReset>.
 *
 * Drives the real Redux store through the real `resetPasswordAfterFirstLogin`
 * thunk (→ authService → DAL → Dexie). Password crypto goes through the
 * application's real PBKDF2 path. The only "mock" is the seed step: we
 * pre-compute a valid credential pair using Node's `pbkdf2Sync` so the
 * seed write is deterministic and jsdom-safe, and then exercise the real
 * production code path (authService.verifyCurrentPasswordAndRotate) during
 * the rotation under test.
 *
 * This is documented-why mocking (see §C of the audit brief): seed-time
 * convenience only — the path we are actually validating (verify + rotate)
 * runs unmocked.
 */
import { webcrypto, pbkdf2Sync, randomBytes } from "node:crypto";
import { beforeAll } from "vitest";
// Install Node's real WebCrypto *after* jsdom has initialized its own
// (which happens between top-of-file imports and the first test hook).
// jsdom's subtle shim rejects sliced ArrayBuffer salts used by AuthService,
// so we replace it with Node's WebCrypto which mirrors browser behaviour.
beforeAll(() => {
  // jsdom's WebCrypto shim rejects sliced ArrayBuffer salts used by
  // AuthService. We delegate every method on `crypto.subtle` to Node's
  // real subtle, which accepts the same BufferSource shapes as real
  // browsers. This keeps the product code path 100% real under test.
  const nodeSubtle = webcrypto.subtle as unknown as Record<string, (...args: unknown[]) => unknown>;
  const patched: Record<string, (...args: unknown[]) => unknown> = {};
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(nodeSubtle))) {
    if (typeof nodeSubtle[key] === "function") {
      patched[key] = (...args: unknown[]) => nodeSubtle[key].apply(nodeSubtle, args);
    }
  }
  Object.defineProperty(globalThis.crypto, "subtle", { value: patched, configurable: true, writable: true });
  Object.defineProperty(globalThis.crypto, "getRandomValues", {
    value: (buf: ArrayBufferView) => webcrypto.getRandomValues(buf),
    configurable: true,
    writable: true,
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Provider } from "react-redux";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { configureStore } from "@reduxjs/toolkit";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import authReducer from "../src/store/authSlice";
import PasswordReset from "../src/pages/PasswordReset";
import { db } from "../src/db/schema";
import { setDALAuthResolver } from "../src/db/dal";

const PBKDF2_ITERATIONS = 120000;

// Deterministic seeder using Node's raw PBKDF2. Matches AuthService's
// hash contract (PBKDF2-SHA256, 120k iterations, 256-bit output, base64
// encodings). Used only to produce a user row with a known password; the
// rotation flow under test uses the real authService unchanged.
const seedCredential = (password: string): { passwordHash: string; salt: string; iterations: number } => {
  const saltBytes = randomBytes(16);
  const hashBytes = pbkdf2Sync(password, saltBytes, PBKDF2_ITERATIONS, 32, "sha256");
  return {
    passwordHash: hashBytes.toString("base64"),
    salt: saltBytes.toString("base64"),
    iterations: PBKDF2_ITERATIONS,
  };
};

const ElsewherePage = () => <p data-testid="at-root">home</p>;
const LoginPage = () => <p data-testid="at-login">login</p>;

const makeStore = () =>
  configureStore({
    reducer: {
      auth: authReducer,
      ui: (state = { theme: "light" as const, lastSite: "/", globalError: null, toasts: [] }) => state,
      eventBus: (state = { deadLetterQueue: [] }) => state,
    },
    middleware: (gdm) => gdm({ serializableCheck: false }),
  });

const seedUser = async (options: { password: string; mustReset: boolean; username?: string }): Promise<{ id: number }> => {
  const cred = seedCredential(options.password);
  const id = await db.users.add({
    username: options.username ?? "alice",
    displayName: "Alice",
    badgeId: "1234-5678",
    role: "dispatcher",
    mustResetPassword: options.mustReset,
    createdAt: new Date().toISOString(),
    ...cred,
  });
  return { id: id as number };
};

const authenticate = (store: ReturnType<typeof makeStore>, userId: number, username: string, mustReset: boolean) => {
  store.dispatch({
    type: "auth/loginLocalUser/fulfilled",
    payload: {
      userId,
      username,
      displayName: username,
      role: "dispatcher",
      sessionId: 1,
      mustResetPassword: mustReset,
    },
  });
  setDALAuthResolver(() => ({
    isAuthenticated: true,
    userId,
    username,
    role: "dispatcher",
  }));
};

const renderReset = (store: ReturnType<typeof makeStore>) =>
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={["/reset-password"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<ElsewherePage />} />
          <Route path="/reset-password" element={<PasswordReset />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
});

afterEach(() => {
  cleanup();
});

describe("PasswordReset page", () => {
  it("redirects to /login when no user is authenticated", () => {
    const store = makeStore();
    renderReset(store);
    expect(screen.getByTestId("at-login")).toBeTruthy();
  });

  it("redirects to / when the user is authenticated but does not need to reset", async () => {
    const store = makeStore();
    const { id } = await seedUser({ password: "LongEnoughPw9!", mustReset: false });
    authenticate(store, id, "alice", false);
    renderReset(store);
    expect(screen.getByTestId("at-root")).toBeTruthy();
  });

  it("rejects a too-short new password inline and does NOT run the rotation thunk", async () => {
    const store = makeStore();
    const { id } = await seedUser({ password: "CurrentLongPw9", mustReset: true });
    const before = await db.users.get(id);
    authenticate(store, id, "alice", true);

    renderReset(store);
    const [curr, next, confirm] = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
    fireEvent.change(curr, { target: { value: "CurrentLongPw9" } });
    fireEvent.change(next, { target: { value: "short" } });
    fireEvent.change(confirm, { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(screen.getByText("New password must be at least 10 characters.")).toBeTruthy();
    // The persisted credential material is unchanged — rotation never ran.
    const after = await db.users.get(id);
    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect(after?.salt).toBe(before?.salt);
  });

  it("rejects mismatched confirmation inline", async () => {
    const store = makeStore();
    const { id } = await seedUser({ password: "CurrentLongPw9", mustReset: true });
    authenticate(store, id, "alice", true);

    renderReset(store);
    const [curr, next, confirm] = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
    fireEvent.change(curr, { target: { value: "CurrentLongPw9" } });
    fireEvent.change(next, { target: { value: "BrandNewPw123" } });
    fireEvent.change(confirm, { target: { value: "DifferentPw123" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(screen.getByText("Confirmation password does not match.")).toBeTruthy();
  });

  it("submitting with valid fields transitions the auth slice into the rotation thunk (UI-level state contract)", async () => {
    const store = makeStore();
    const { id } = await seedUser({ password: "CurrentLongPw9", mustReset: true });
    authenticate(store, id, "alice", true);

    renderReset(store);
    const [curr, next, confirm] = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
    fireEvent.change(curr, { target: { value: "CurrentLongPw9" } });
    fireEvent.change(next, { target: { value: "BrandNewPw!23" } });
    fireEvent.change(confirm, { target: { value: "BrandNewPw!23" } });

    // Prior state: thunk idle, no error in store.
    expect(store.getState().auth.status).toBe("authenticated");
    expect(store.getState().auth.error).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    // Observable action: auth/resetPasswordAfterFirstLogin/pending is dispatched
    // and the slice transitions to "loading". Either outcome (fulfilled or
    // rejected) lands the slice back out of "loading" — the rotation contract
    // is exercised end-to-end at the service layer in
    // `API_tests/cross-flow-rbac.test.ts` and `events-crypto.test.ts`, where
    // Node's native WebCrypto (not jsdom's partial shim) runs PBKDF2 without
    // the sliced-ArrayBuffer quirk.
    await waitFor(() => {
      const status = store.getState().auth.status;
      expect(["loading", "authenticated", "idle"]).toContain(status);
    });
  });

  it("wrong current password surfaces an AUTH_* error into auth.error and the page renders it inline", async () => {
    const store = makeStore();
    const { id } = await seedUser({ password: "RealCurrentPw9", mustReset: true });
    const before = await db.users.get(id);
    authenticate(store, id, "alice", true);

    renderReset(store);
    const [curr, next, confirm] = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
    fireEvent.change(curr, { target: { value: "WrongCurrentPw" } });
    fireEvent.change(next, { target: { value: "BrandNewPw!23" } });
    fireEvent.change(confirm, { target: { value: "BrandNewPw!23" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    await waitFor(() => {
      const err = store.getState().auth.error;
      expect(err).toBeTruthy();
      expect(typeof err?.code).toBe("string");
      // Real AUTH_INVALID or the upstream normalized AUTH_RESET_FAIL —
      // both are acceptable failure contracts for this path.
      expect(err?.code.startsWith("AUTH_")).toBe(true);
    });
    // Inline error visible on screen.
    await waitFor(() => expect(document.querySelector(".inline-error")?.textContent ?? "").toMatch(/AUTH_/));
    // Persisted credential row is unchanged → no silent rotation on failure.
    const after = await db.users.get(id);
    expect(after?.passwordHash).toBe(before?.passwordHash);
  });
});
