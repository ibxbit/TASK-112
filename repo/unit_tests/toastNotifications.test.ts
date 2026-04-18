import { describe, expect, it } from "vitest";
import { store } from "../src/store";

describe("toast notifications", () => {
  it("converts AUTH_403 rejections into permission-error toast", () => {
    store.dispatch({
      type: "demo/action/rejected",
      payload: {
        code: "AUTH_403",
        message: "Forbidden",
        context: { operation: "write", table: "tasks" },
        retryable: false,
      },
    });

    const toasts = store.getState().ui.toasts;
    const latest = toasts[toasts.length - 1];
    expect(latest.variant).toBe("permission-error");
    expect(latest.durationMs).toBe(6000);
  });
});
