// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import AdminConsole from "../src/pages/AdminConsole";
import { db } from "../src/db/schema";
import { buildSession, cleanup, renderWithProviders, resetDatabase } from "./helpers/renderHarness";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(async () => {
  await resetDatabase();
});

const findByPlaceholder = (placeholder: string, scope: ParentNode = document): HTMLInputElement => {
  const el = scope.querySelector(`input[placeholder="${placeholder}"]`);
  if (!el) {
    throw new Error(`input[placeholder="${placeholder}"] not found`);
  }
  return el as HTMLInputElement;
};

const cardByHeading = (heading: string): HTMLElement => {
  const h3 = Array.from(document.querySelectorAll("h3")).find((node) => node.textContent === heading);
  if (!h3) {
    throw new Error(`<h3>${heading}</h3> not rendered yet`);
  }
  return h3.closest("article") as HTMLElement;
};

describe("AdminConsole", () => {
  it("Create Warehouse Site writes a site row via the real DAL and renders it in the table", async () => {
    renderWithProviders(<AdminConsole />, buildSession("administrator"));
    await waitFor(() => screen.getByText("Warehouse Sites"));

    const siteCard = cardByHeading("Warehouse Sites");
    act(() => {
      fireEvent.change(findByPlaceholder("site code", siteCard), { target: { value: "NY-01" } });
      fireEvent.change(findByPlaceholder("site name", siteCard), { target: { value: "New York Core" } });
      fireEvent.change(findByPlaceholder("timezone", siteCard), { target: { value: "America/New_York" } });
    });

    fireEvent.click(screen.getByRole("button", { name: "Create Site" }));

    await waitFor(async () => {
      const sites = await db.warehouse_sites.toArray();
      expect(sites.some((s) => s.code === "NY-01" && s.name === "New York Core" && s.active === true)).toBe(true);
    });
    // Observable: row visible in the sites table
    await waitFor(() => expect(screen.getByText("NY-01")).toBeTruthy());
  });

  it("Save Equipment Adapter persists and reflects the adapter table entry", async () => {
    renderWithProviders(<AdminConsole />, buildSession("administrator"));
    await waitFor(() => screen.getByText("Equipment Adapters"));

    const adapterCard = cardByHeading("Equipment Adapters");
    act(() => {
      fireEvent.change(findByPlaceholder("adapter key", adapterCard), { target: { value: "agv-north" } });
      fireEvent.change(findByPlaceholder("display name", adapterCard), { target: { value: "AGV North Loop" } });
      fireEvent.change(findByPlaceholder("endpoint", adapterCard), { target: { value: "mqtt://broker:1883/agv" } });
    });

    fireEvent.click(screen.getByRole("button", { name: "Create Adapter" }));

    // The DAL upper-cases adapter keys via normalizeAdminKey; assert the
    // normalized form lives in Dexie and renders in the table.
    await waitFor(async () => {
      const rows = await db.equipment_adapters.toArray();
      expect(rows.some((r) => r.adapterKey === "AGV-NORTH" && r.endpoint === "mqtt://broker:1883/agv")).toBe(true);
    });
    await waitFor(() => expect(screen.getByText("AGV-NORTH")).toBeTruthy());
  });

  it("Save Operational Template persists template and renders it in the template list", async () => {
    renderWithProviders(<AdminConsole />, buildSession("administrator"));
    await waitFor(() => screen.getByText("Operational Templates"));

    const tplCard = cardByHeading("Operational Templates");
    act(() => {
      fireEvent.change(findByPlaceholder("template key", tplCard), { target: { value: "tpl-putaway-default" } });
      fireEvent.change(findByPlaceholder("template name", tplCard), { target: { value: "Default Putaway" } });
      fireEvent.change(findByPlaceholder("template content", tplCard), { target: { value: "1. Scan 2. Place" } });
    });

    fireEvent.click(screen.getByRole("button", { name: "Create Template" }));

    await waitFor(async () => {
      const rows = await db.operational_templates.toArray();
      expect(rows.some((r) => r.templateKey === "TPL-PUTAWAY-DEFAULT")).toBe(true);
    });
    await waitFor(() => expect(screen.getByText("TPL-PUTAWAY-DEFAULT")).toBeTruthy());
  });

  it("Save Permission Override writes a row reflecting the read/write booleans", async () => {
    renderWithProviders(<AdminConsole />, buildSession("administrator"));
    await waitFor(() => screen.getByText("Permission Overrides"));

    // Find the Save Override button and climb to its card, then grab the
    // first non-checkbox input inside — avoids false positives from other cards.
    const saveBtn = screen.getByRole("button", { name: "Save Override" });
    const card = saveBtn.closest("article") as HTMLElement;
    expect(card).toBeTruthy();
    const scopeInput = Array.from(card.querySelectorAll("input")).find(
      (el) => el.type !== "checkbox" && el.type !== "file",
    ) as HTMLInputElement | undefined;
    expect(scopeInput).toBeTruthy();

    act(() => {
      fireEvent.change(scopeInput as HTMLInputElement, { target: { value: "calendar_events" } });
    });
    fireEvent.click(saveBtn);

    await waitFor(async () => {
      const rows = await db.permission_overrides.toArray();
      const match = rows.find((r) => r.scope === "calendar_events");
      expect(match).toBeTruthy();
      expect(match?.canRead).toBe(true);
      expect(match?.canWrite).toBe(false);
    });
  });

  it("Rejects access / surfaces AUTH_403 when a non-admin session tries to load the console (listUsers fails)", async () => {
    renderWithProviders(<AdminConsole />, buildSession("dispatcher"));
    await waitFor(() => screen.getByText("Administrator Console"));
    // The load() throws WOGCError(AUTH_403) and the component sets toast to "AUTH_403: ...".
    await waitFor(() => expect(screen.getByText(/AUTH_403/)).toBeTruthy());
  });
});
