// @vitest-environment jsdom
/**
 * Behavior matrix for <GlobalErrorBoundary>.
 *
 * The boundary's job is to convert raw failures into the WOGCError contract
 * and render either a "Retry" affordance (retryable=true) or a terminal
 * "System Halt" notice (retryable=false). Tests render the real boundary
 * around a throwing child and assert on rendered output. No spies.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import { GlobalErrorBoundary } from "../src/components/GlobalErrorBoundary";
import { WOGCError } from "../src/utils/errors";

// Suppress React's intentional error-boundary stderr to keep test output clean.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const silenceReactError = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

const Thrower: React.FC<{ when: boolean; error: unknown }> = ({ when, error }) => {
  if (when) {
    throw error;
  }
  return <p data-testid="child-ok">healthy child</p>;
};

describe("<GlobalErrorBoundary />", () => {
  it("passes through children when no error is thrown", () => {
    render(
      <GlobalErrorBoundary>
        <Thrower when={false} error={null} />
      </GlobalErrorBoundary>,
    );
    expect(screen.getByTestId("child-ok")).toBeTruthy();
    expect(screen.queryByText("System Fault")).toBeNull();
  });

  it("catches a WOGCError(retryable=true) and renders the Retry button with code/message", () => {
    silenceReactError();
    const err = new WOGCError({
      code: "EQUIP_TIMEOUT",
      message: "No heartbeat for 20s",
      context: {},
      retryable: true,
    });
    render(
      <GlobalErrorBoundary>
        <Thrower when={true} error={err} />
      </GlobalErrorBoundary>,
    );
    expect(screen.getByText("System Fault")).toBeTruthy();
    expect(screen.getByText("EQUIP_TIMEOUT", { exact: false })).toBeTruthy();
    expect(screen.getByText("No heartbeat for 20s", { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    // Terminal copy should NOT be present when retryable.
    expect(screen.queryByText(/System Halt/)).toBeNull();
  });

  it("catches a WOGCError(retryable=false) and hides Retry, showing System Halt", () => {
    silenceReactError();
    const err = new WOGCError({
      code: "AUTH_403",
      message: "Access denied",
      context: { operation: "write" },
      retryable: false,
    });
    render(
      <GlobalErrorBoundary>
        <Thrower when={true} error={err} />
      </GlobalErrorBoundary>,
    );
    expect(screen.getByText("System Fault")).toBeTruthy();
    expect(screen.getByText("AUTH_403", { exact: false })).toBeTruthy();
    expect(screen.getByText(/System Halt/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("normalizes a raw JavaScript TypeError into a WOGCError and renders the fallback UNEXPECTED code", () => {
    silenceReactError();
    render(
      <GlobalErrorBoundary>
        <Thrower when={true} error={new TypeError("cannot read x of undefined")} />
      </GlobalErrorBoundary>,
    );
    expect(screen.getByText("System Fault")).toBeTruthy();
    // ensureWOGCError falls back to code=UNEXPECTED and preserves the JS message.
    expect(screen.getByText(/UNEXPECTED/)).toBeTruthy();
    expect(screen.getByText(/cannot read x of undefined/)).toBeTruthy();
    // Default fallback marks UNEXPECTED as retryable=true → Retry button present.
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("clicking Retry clears error state so a recovered child is rendered again", () => {
    silenceReactError();

    // Host that controls whether the child throws — flips to healthy on Retry.
    const Host: React.FC = () => {
      const [broken, setBroken] = useState(true);
      return (
        <>
          <button type="button" data-testid="fix-btn" onClick={() => setBroken(false)}>fix</button>
          <GlobalErrorBoundary>
            <Thrower when={broken} error={new WOGCError({ code: "X", message: "temp", retryable: true })} />
          </GlobalErrorBoundary>
        </>
      );
    };

    render(<Host />);

    // Initial: boundary in error state.
    expect(screen.getByText("System Fault")).toBeTruthy();
    expect(screen.queryByTestId("child-ok")).toBeNull();

    // Simulate upstream fix, then ask the boundary to retry.
    fireEvent.click(screen.getByTestId("fix-btn"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    // State transition: error gone, child rendered.
    expect(screen.queryByText("System Fault")).toBeNull();
    expect(screen.getByTestId("child-ok")).toBeTruthy();
  });
});
