// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import ToastViewport from "../src/components/ToastViewport";
import { buildSession, cleanup, renderWithProviders } from "./helpers/renderHarness";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const pushToast = (store: { dispatch: (a: unknown) => unknown }, variant: string, message: string, durationMs = 3000) => {
  store.dispatch({
    type: "ui/enqueueToast",
    payload: { id: `t_${message}`, variant, message, durationMs },
  });
};

describe("<ToastViewport />", () => {
  it("renders one toast per ui.toasts entry and applies variant-appropriate aria-live", () => {
    const harness = renderWithProviders(<ToastViewport />, buildSession("dispatcher"));
    act(() => {
      pushToast(harness.store, "success", "saved-ok");
      pushToast(harness.store, "error", "op-blew-up");
      pushToast(harness.store, "permission-error", "nope");
    });
    const saved = screen.getByText("saved-ok");
    const failed = screen.getByText("op-blew-up");
    const denied = screen.getByText("nope");

    expect(saved.closest("article")?.getAttribute("aria-live")).toBe("polite");
    expect(failed.closest("article")?.getAttribute("aria-live")).toBe("assertive");
    expect(denied.closest("article")?.getAttribute("aria-live")).toBe("assertive");
    expect(failed.closest("article")?.getAttribute("role")).toBe("alert");
  });

  it("dismiss button removes only the clicked toast and preserves siblings (state transition observed)", () => {
    const harness = renderWithProviders(<ToastViewport />, buildSession("dispatcher"));
    act(() => {
      pushToast(harness.store, "info", "keep-me");
      pushToast(harness.store, "warning", "drop-me");
    });

    // Pre-state: two toasts in the UI slice, two in the DOM.
    expect(harness.store.getState().ui.toasts).toHaveLength(2);
    expect(screen.queryByText("keep-me")).toBeTruthy();
    expect(screen.queryByText("drop-me")).toBeTruthy();

    // Action: dismiss the "drop-me" toast. Each toast has its own Dismiss button.
    const dropArticle = screen.getByText("drop-me").closest("article") as HTMLElement;
    const dismiss = dropArticle.querySelector("button.toast-close") as HTMLButtonElement;
    act(() => {
      fireEvent.click(dismiss);
    });

    // Post-state: only the preserved toast remains, both in DOM and store.
    expect(harness.store.getState().ui.toasts.map((t: { message: string }) => t.message)).toEqual(["keep-me"]);
    expect(screen.queryByText("drop-me")).toBeNull();
    expect(screen.queryByText("keep-me")).toBeTruthy();
  });

  it("auto-dismisses a toast after its durationMs elapses (useEffect timer contract)", () => {
    vi.useFakeTimers();
    const harness = renderWithProviders(<ToastViewport />, buildSession("dispatcher"));
    act(() => {
      pushToast(harness.store, "info", "ephemeral", 1500);
    });
    expect(screen.queryByText("ephemeral")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(screen.queryByText("ephemeral")).toBeTruthy(); // not yet

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(harness.store.getState().ui.toasts).toHaveLength(0);
    expect(screen.queryByText("ephemeral")).toBeNull();
  });

  it("undo button dispatches the declared action type and removes the toast", () => {
    const harness = renderWithProviders(<ToastViewport />, buildSession("administrator"));
    const seen: Array<{ type: string; payload?: unknown }> = [];
    const rawDispatch = harness.store.dispatch;
    harness.store.dispatch = ((action: { type: string; payload?: unknown }) => {
      seen.push(action);
      return rawDispatch(action);
    }) as typeof harness.store.dispatch;

    act(() => {
      harness.store.dispatch({
        type: "ui/enqueueToast",
        payload: {
          id: "t_undo",
          variant: "info",
          message: "deleted-row",
          durationMs: 3000,
          undo: { label: "Undo", actionType: "tasks/restore", payload: { taskId: 77 } },
        },
      });
    });

    const undoBtn = screen.getByRole("button", { name: "Undo" });
    act(() => {
      fireEvent.click(undoBtn);
    });

    expect(seen.some((a) => a.type === "tasks/restore" && (a.payload as { taskId: number }).taskId === 77)).toBe(true);
    expect(harness.store.getState().ui.toasts).toHaveLength(0);
  });
});
