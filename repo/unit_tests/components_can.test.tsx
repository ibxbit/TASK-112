// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import Can from "../src/components/Can";
import { buildSession, cleanup, renderWithProviders } from "./helpers/renderHarness";

afterEach(() => {
  cleanup();
});

// Behavioral matrix for <Can>: gate children on the live Redux role.
describe("<Can />", () => {
  it("renders children when current session role holds the permission", () => {
    renderWithProviders(
      <Can permission="equipment:command">
        <button type="button">Issue Command</button>
      </Can>,
      buildSession("dispatcher"),
    );
    expect(screen.getByRole("button", { name: "Issue Command" })).toBeTruthy();
  });

  it("renders null when role lacks permission and no fallback is provided", () => {
    renderWithProviders(
      <Can permission="equipment:command">
        <button type="button">Issue Command</button>
      </Can>,
      buildSession("operator"),
    );
    expect(screen.queryByRole("button", { name: "Issue Command" })).toBeNull();
  });

  it("renders the supplied fallback when role lacks permission", () => {
    renderWithProviders(
      <Can permission="audit:verify" fallback={<p>forbidden</p>}>
        <button type="button">Verify</button>
      </Can>,
      buildSession("operator"),
    );
    expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
    expect(screen.getByText("forbidden")).toBeTruthy();
  });

  it("updates gate output when session role is swapped mid-session (observable state transition)", () => {
    const harness = renderWithProviders(
      <Can permission="tasks:create"><span>create-allowed</span></Can>,
      buildSession("viewer"),
    );
    expect(screen.queryByText("create-allowed")).toBeNull();
    harness.replaceSession(buildSession("dispatcher", { userId: 2 }));
    // After role swap, the next render (triggered by Redux subscription) must expose the child.
    harness.rerender(
      <Can permission="tasks:create"><span>create-allowed</span></Can>,
    );
    expect(screen.getByText("create-allowed")).toBeTruthy();
  });
});
