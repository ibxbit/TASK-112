// @vitest-environment jsdom
/**
 * Behavior matrix for <RoleGate>.
 *
 * Drives the real Redux store + real Dexie DAL (fake-indexeddb).
 * Intentionally avoids mocks: we want to verify the side-effect chain
 * (toast enqueued, permission-denied audit row appended, redirect target
 * computed) rather than that a spy was called.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Provider } from "react-redux";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { configureStore } from "@reduxjs/toolkit";
import { cleanup, render, screen } from "@testing-library/react";
import authReducer from "../src/store/authSlice";
import RoleGate from "../src/components/RoleGate";
import { db } from "../src/db/schema";
import { setDALAuthResolver } from "../src/db/dal";

type UIState = {
  theme: "light";
  lastSite: string;
  globalError: unknown;
  toasts: Array<{ id: string; variant: string; message: string; durationMs: number }>;
};

const makeStore = (role: string | null) => {
  const store = configureStore({
    reducer: {
      auth: authReducer,
      ui: (state: UIState = { theme: "light", lastSite: "/", globalError: null, toasts: [] }, action: { type: string; payload?: unknown }) => {
        if (action.type === "ui/enqueueToast") {
          const p = (action.payload ?? {}) as Record<string, unknown>;
          return {
            ...state,
            toasts: [...state.toasts, {
              id: (p.id as string) ?? `t_${Date.now()}`,
              variant: String(p.variant ?? "info"),
              message: String(p.message ?? ""),
              durationMs: Number(p.durationMs ?? 3000),
            }],
          };
        }
        return state;
      },
      eventBus: (state = { deadLetterQueue: [] }) => state,
    },
    middleware: (gdm) => gdm({ serializableCheck: false }),
  });
  store.dispatch({ type: "auth/logout" });
  if (role) {
    store.dispatch({
      type: "auth/loginLocalUser/fulfilled",
      payload: {
        userId: 1,
        username: `${role}-u`,
        displayName: `${role}-u`,
        role,
        sessionId: 1,
        mustResetPassword: false,
      },
    });
  }
  setDALAuthResolver(() => ({
    isAuthenticated: Boolean(role),
    userId: role ? 1 : null,
    username: role ? `${role}-u` : null,
    role: (role ?? null) as never,
  }));
  return store;
};

const resetDb = async () => {
  for (const table of db.tables) {
    await table.clear();
  }
};

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  cleanup();
});

const Protected = () => <p data-testid="protected">secret content</p>;
const LoginPage = () => <p data-testid="at-login">login screen</p>;
const ForbiddenPage = () => <p data-testid="at-forbidden">forbidden</p>;

const renderGate = (node: JSX.Element, store: ReturnType<typeof makeStore>, initial = "/protected") =>
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forbidden" element={<ForbiddenPage />} />
          <Route path="/protected" element={node} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );

describe("<RoleGate />", () => {
  it("when no session exists it redirects to /login (child never renders)", () => {
    const store = makeStore(null);
    renderGate(
      <RoleGate permission="tasks:read"><Protected /></RoleGate>,
      store,
    );
    expect(screen.getByTestId("at-login")).toBeTruthy();
    expect(screen.queryByTestId("protected")).toBeNull();
  });

  it("renders children when the session role holds the permission", () => {
    const store = makeStore("dispatcher");
    renderGate(
      <RoleGate permission="tasks:read"><Protected /></RoleGate>,
      store,
    );
    expect(screen.getByTestId("protected")).toBeTruthy();
  });

  it("redirects to /forbidden, enqueues a permission-error toast, and writes an audit row when permission is missing", async () => {
    const store = makeStore("viewer");
    renderGate(
      <RoleGate permission="tasks:assign"><Protected /></RoleGate>,
      store,
    );

    // Behaviour 1: destination switched to /forbidden.
    expect(screen.getByTestId("at-forbidden")).toBeTruthy();
    expect(screen.queryByTestId("protected")).toBeNull();

    // Behaviour 2: toast slice received a permission-error message
    // mentioning the attempted permission (no spy; we inspect real state).
    const toast = store.getState().ui.toasts.find((t) => t.variant === "permission-error");
    expect(toast?.message).toMatch(/tasks:assign/);

    // Behaviour 3: audit_log row was appended — side effect of the guard
    // (route_guard reason). Give Dexie a microtask to settle.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const entries = await db.audit_log.toArray();
    const denial = entries.find((row) => row.action === "permission.denied");
    expect(denial).toBeTruthy();
    // The DAL stores route_guard denials as entity=permission+operation=read.
    expect(denial?.entity).toBe("tasks:assign");
    expect(denial?.details).toMatchObject({ operation: "read", reason: "route_guard", table: "tasks:assign" });
  });

  it("redirects to /forbidden when `allowed` list excludes current role, without a permission string", () => {
    const store = makeStore("operator");
    renderGate(
      <RoleGate allowed={["administrator", "dispatcher"]}><Protected /></RoleGate>,
      store,
    );
    expect(screen.getByTestId("at-forbidden")).toBeTruthy();
    expect(screen.queryByTestId("protected")).toBeNull();
  });

  it("session role that satisfies `allowed` renders children and does NOT enqueue a denial toast", () => {
    const store = makeStore("administrator");
    renderGate(
      <RoleGate allowed={["administrator", "auditor"]}><Protected /></RoleGate>,
      store,
    );
    expect(screen.getByTestId("protected")).toBeTruthy();
    // No permission-error toast was queued.
    expect(store.getState().ui.toasts.some((t) => t.variant === "permission-error")).toBe(false);
  });
});
