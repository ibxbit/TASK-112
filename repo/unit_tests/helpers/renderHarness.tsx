// @vitest-environment jsdom
/**
 * Shared render harness for UI tests.
 *
 * Every helper here is intentionally small and observable:
 *   - No module-scoped mutable state leaking across tests.
 *   - No spies/mocks are installed globally — we drive the *real* DAL (Dexie
 *     over fake-indexeddb), the *real* Redux store, and the *real* event bus.
 *     Tests only stub out wall-clock crypto when the test has to deterministically
 *     fail (clearly localised to that test).
 *   - `resetDatabase` is idempotent — callable from `beforeEach` across files.
 */
import type { ReactElement } from "react";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";
import { configureStore } from "@reduxjs/toolkit";
import { cleanup, render } from "@testing-library/react";

/**
 * Explicit cleanup helper re-exported so tests can call it in `afterEach`
 * and guarantee each test starts with an empty DOM, irrespective of whether
 * Vitest's auto-cleanup environment hook happens to be active.
 */
export { cleanup };
import { db, type UserRole } from "../../src/db/schema";
import authReducer, { logout } from "../../src/store/authSlice";
import { setDALAuthResolver } from "../../src/db/dal";

export type SessionSnapshot = {
  isAuthenticated: boolean;
  userId: number | null;
  username: string | null;
  role: UserRole | null;
};

export const buildSession = (role: UserRole, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  isAuthenticated: true,
  userId: overrides.userId ?? 1,
  username: overrides.username ?? `${role}-user`,
  role,
  ...overrides,
});

/**
 * Build a minimal but complete Redux store matching the shape the components
 * actually read (auth + ui + eventBus). Returns both the store and a setter
 * so the test can swap the session without tearing the render tree down.
 */
export const buildTestStore = (initialSession: SessionSnapshot) => {
  const uiInitial = {
    theme: "light" as "light" | "dark",
    lastSite: "/",
    globalError: null as unknown,
    toasts: [] as Array<{ id: string; variant: string; message: string; durationMs: number }>,
  };
  const eventBusInitial = { deadLetterQueue: [] as unknown[] };

  const store = configureStore({
    reducer: {
      auth: authReducer,
      ui: (state = uiInitial, action: { type: string; payload?: unknown }) => {
        switch (action.type) {
          case "ui/setTheme":
            return { ...state, theme: action.payload as "light" | "dark" };
          case "ui/setLastSite":
            return { ...state, lastSite: String(action.payload) };
          case "ui/enqueueToast": {
            const p = (action.payload ?? {}) as Record<string, unknown>;
            return {
              ...state,
              toasts: [
                ...state.toasts,
                {
                  id: (p.id as string) ?? `t_${state.toasts.length}_${Date.now()}`,
                  variant: String(p.variant ?? "info"),
                  message: String(p.message ?? ""),
                  durationMs: Number(p.durationMs ?? 3000),
                  ...(p as object),
                },
              ],
            };
          }
          case "ui/dismissToast":
            return { ...state, toasts: state.toasts.filter((t) => t.id !== action.payload) };
          default:
            return state;
        }
      },
      eventBus: (state = eventBusInitial) => state,
    },
    middleware: (gdm) => gdm({ serializableCheck: false }),
  });

  // Seed the auth slice with the requested session.
  store.dispatch({ type: "auth/logout" }); // ensure clean
  if (initialSession.isAuthenticated && initialSession.role && initialSession.userId) {
    // Patch the auth state directly via a synthetic fulfilled action —
    // the only way to mark the session "authenticated" without running the
    // real thunk (which would hit Dexie for crypto).
    store.dispatch({
      type: "auth/loginLocalUser/fulfilled",
      payload: {
        userId: initialSession.userId,
        username: initialSession.username,
        displayName: initialSession.username,
        role: initialSession.role,
        sessionId: 1,
        mustResetPassword: false,
      },
    });
  }

  // Wire DAL auth resolver so permission checks read this store.
  setDALAuthResolver(() => ({
    isAuthenticated: store.getState().auth.isAuthenticated,
    userId: store.getState().auth.userId,
    username: store.getState().auth.username,
    role: store.getState().auth.role,
  }));

  return {
    store,
    logoutSession: () => store.dispatch(logout()),
    replaceSession: (next: SessionSnapshot) => {
      store.dispatch(logout());
      if (next.isAuthenticated && next.role && next.userId) {
        store.dispatch({
          type: "auth/loginLocalUser/fulfilled",
          payload: {
            userId: next.userId,
            username: next.username,
            displayName: next.username,
            role: next.role,
            sessionId: 2,
            mustResetPassword: false,
          },
        });
      }
    },
  };
};

export const renderWithProviders = (ui: ReactElement, session: SessionSnapshot = buildSession("administrator")) => {
  const harness = buildTestStore(session);
  const Wrapper = ({ children }: { children: ReactElement }) => (
    <Provider store={harness.store}>
      <MemoryRouter>{children}</MemoryRouter>
    </Provider>
  );
  // RTL re-applies the wrapper automatically on rerender when we use the
  // `wrapper` option — that keeps the Provider + Router stable across
  // subsequent calls.
  const utils = render(ui, { wrapper: Wrapper });
  return { ...utils, ...harness };
};

/**
 * Idempotent database reset. Every test that touches Dexie should call this
 * in `beforeEach` to guarantee isolation regardless of execution order.
 */
export const resetDatabase = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

/**
 * Flush pending microtasks and timers triggered by useEffect.
 * React 18 defers effects, so tests that read DOM after mount need to wait
 * for the async load cycle.
 */
export const flushAsync = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};
