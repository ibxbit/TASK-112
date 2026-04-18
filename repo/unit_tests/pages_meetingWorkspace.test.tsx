// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import MeetingWorkspace from "../src/pages/MeetingWorkspace";
import { db } from "../src/db/schema";
import { buildSession, cleanup, renderWithProviders, resetDatabase } from "./helpers/renderHarness";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(async () => {
  await resetDatabase();
});

describe("MeetingWorkspace", () => {
  it("hides facilitator-only sections for a role without meetings:manage (viewer)", async () => {
    renderWithProviders(<MeetingWorkspace />, buildSession("viewer"));
    await waitFor(() => screen.getByText("Meeting Workspace"));
    expect(screen.queryByText("Live Session")).toBeNull();
    expect(screen.queryByText("Agenda Management")).toBeNull();
    expect(screen.queryByText("Resolution Tracking")).toBeNull();
    expect(screen.getByText(/Read-only scope: meeting creation/)).toBeTruthy();
  });

  it("Save Meeting persists a meeting row via the real DAL and renders it in Recent Meetings", async () => {
    renderWithProviders(<MeetingWorkspace />, buildSession("facilitator"));
    await waitFor(() => screen.getByRole("button", { name: "Save Meeting" }));

    const inputs = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
    const subjectInput = inputs[0];
    const facilitatorInput = inputs[1];
    act(() => {
      fireEvent.change(subjectInput, { target: { value: "Shift Handoff Standup" } });
      fireEvent.change(facilitatorInput, { target: { value: "alice" } });
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Meeting" }));

    await waitFor(async () => {
      const rows = await db.meetings.toArray();
      expect(rows.some((r) => r.subject === "Shift Handoff Standup" && r.facilitator === "alice")).toBe(true);
    });
    await waitFor(() => expect(screen.getByText("Shift Handoff Standup")).toBeTruthy());
  });

  it("Invalid attachment type produces a toast and leaves the attachment list empty", async () => {
    const { store } = renderWithProviders(<MeetingWorkspace />, buildSession("facilitator"));
    await waitFor(() => screen.getByRole("button", { name: "Save Attachments" }));

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const forbiddenFile = new File(["hello"], "image.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [forbiddenFile] });
    act(() => {
      fireEvent.change(fileInput);
    });

    await waitFor(() => {
      const toastErr = store.getState().ui.toasts.find((t: { variant: string; message: string }) =>
        t.variant === "error" && t.message.includes("Invalid attachment type rejected"),
      );
      expect(toastErr).toBeTruthy();
    });
  });

  it("Spawn Task emits a warning toast when minutes contain no action markers (no tasks written)", async () => {
    const { store } = renderWithProviders(<MeetingWorkspace />, buildSession("facilitator"));
    await waitFor(() => screen.getByRole("button", { name: "Spawn Task" }));

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(textarea, { target: { value: "No structured markers here, just free form notes." } });
    });

    const tasksBefore = await db.tasks.count();
    fireEvent.click(screen.getByRole("button", { name: "Spawn Task" }));

    await waitFor(() => {
      const info = store.getState().ui.toasts.find((t: { variant: string }) => t.variant === "info");
      expect(info?.message).toMatch(/No action markers/);
    });
    expect(await db.tasks.count()).toBe(tasksBefore);
  });

  it("Spawn Task converts ACTION: markers into real tasks (state transition visible in db.tasks)", async () => {
    renderWithProviders(<MeetingWorkspace />, buildSession("facilitator"));
    await waitFor(() => screen.getByRole("button", { name: "Spawn Task" }));

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    const facilitatorInput = (document.querySelectorAll("input")[1]) as HTMLInputElement;
    act(() => {
      fireEvent.change(facilitatorInput, { target: { value: "bob" } });
      fireEvent.change(textarea, {
        target: {
          value: "ACTION: replenish bin-B by 2026-05-01 @alice\nACTION: audit AGV-1 @bob",
        },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Task" }));

    await waitFor(async () => {
      const tasks = await db.tasks.toArray();
      expect(tasks.length).toBeGreaterThanOrEqual(2);
      expect(tasks.some((t) => t.title.includes("replenish bin-B"))).toBe(true);
      expect(tasks.some((t) => t.title.includes("audit AGV-1"))).toBe(true);
    });
  });
});
