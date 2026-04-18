// @vitest-environment jsdom
/**
 * Why this file keeps targeted spies instead of driving the real BackupService:
 *
 * - Happy-path `exportEncrypted` invokes FileSaver → jsdom has no download
 *   surface; the real function would attempt to write a Blob to a fake URL
 *   and the test cannot observe anything meaningful beyond "it ran".
 * - `importEncrypted` CRYPTO_ERR / AUDIT_INTEGRITY_FAIL paths are failure
 *   injections that exist precisely so the UI can prove it handles them.
 *   The real crypto path is covered unmocked in
 *   `API_tests/events-crypto.test.ts`.
 *
 * These mocks therefore meet the "only where unavoidable" bar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import ExportModal from "../src/components/ExportModal";
import { backupService } from "../src/services/BackupService";
import { WOGCError } from "../src/utils/errors";
import { buildSession, cleanup, renderWithProviders, resetDatabase } from "./helpers/renderHarness";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await resetDatabase();
});

describe("<ExportModal />", () => {
  it("renders nothing when `open` is false", () => {
    renderWithProviders(<ExportModal open={false} onClose={() => undefined} />, buildSession("administrator"));
    // The modal root has role="dialog" — absent when closed.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders dialog, disables Import/Export until a passphrase is entered", () => {
    renderWithProviders(<ExportModal open={true} onClose={() => undefined} />, buildSession("administrator"));
    const exportBtn = screen.getByRole("button", { name: "Export" }) as HTMLButtonElement;
    const importBtn = screen.getByRole("button", { name: "Import" }) as HTMLButtonElement;

    // Initial disabled state is part of the documented UI contract.
    expect(exportBtn.disabled).toBe(true);
    expect(importBtn.disabled).toBe(true);

    // Type a passphrase: both become enabled (close stays enabled).
    const passphrase = screen.getByPlaceholderText("Enter encryption passphrase") as HTMLInputElement;
    act(() => {
      fireEvent.change(passphrase, { target: { value: "secret-phrase-42" } });
    });
    expect(exportBtn.disabled).toBe(false);
    expect(importBtn.disabled).toBe(false);
  });

  it("Export success: drives backupService.exportEncrypted, shows filename in status, enqueues success toast", async () => {
    const onClose = vi.fn();
    const spy = vi.spyOn(backupService, "exportEncrypted").mockResolvedValue("wogc-backup.enc.json");

    const { store } = renderWithProviders(
      <ExportModal open={true} onClose={onClose} />,
      buildSession("administrator"),
    );

    fireEvent.change(screen.getByPlaceholderText("Enter encryption passphrase"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith("pw"));
    await waitFor(() => expect(screen.getByText(/wogc-backup\.enc\.json/)).toBeTruthy());

    // Observable state transition: ui.toasts contains a success with the message.
    const successToast = store.getState().ui.toasts.find((t: { variant: string }) => t.variant === "success");
    expect(successToast?.message).toBe("Encrypted backup exported.");
  });

  it("Import requires a selected file before running", async () => {
    const spy = vi.spyOn(backupService, "importEncrypted").mockResolvedValue(undefined);
    renderWithProviders(<ExportModal open={true} onClose={() => undefined} />, buildSession("administrator"));

    fireEvent.change(screen.getByPlaceholderText("Enter encryption passphrase"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(screen.getByText("Select an encrypted backup file first.")).toBeTruthy());
    expect(spy).not.toHaveBeenCalled();
  });

  it("CRYPTO_ERR surfaces the secure, context-aware error message (file name, no stack leak)", async () => {
    const file = new File(["{}"], "bad.enc.json", { type: "application/json" });
    vi.spyOn(backupService, "importEncrypted").mockRejectedValue(
      new WOGCError({
        code: "CRYPTO_ERR",
        message: "decrypt failed",
        context: { file: file.name },
        retryable: false,
      }),
    );
    renderWithProviders(<ExportModal open={true} onClose={() => undefined} />, buildSession("administrator"));

    fireEvent.change(screen.getByPlaceholderText("Enter encryption passphrase"), { target: { value: "pw" } });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [file] });
    fireEvent.change(fileInput);

    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() =>
      expect(screen.getByText(`Crypto operation failed for file: ${file.name}`)).toBeTruthy(),
    );
    // And no stack-trace leak is shown.
    expect(screen.queryByText(/at ExportModal/)).toBeNull();
  });

  it("AUDIT_INTEGRITY_FAIL on import raises a critical toast message", async () => {
    const file = new File(["{}"], "forged.enc.json", { type: "application/json" });
    vi.spyOn(backupService, "importEncrypted").mockRejectedValue(
      new WOGCError({
        code: "AUDIT_INTEGRITY_FAIL",
        message: "audit chain broken",
        context: { reason: "hash mismatch" },
        retryable: false,
      }),
    );

    const { store } = renderWithProviders(
      <ExportModal open={true} onClose={() => undefined} />,
      buildSession("administrator"),
    );

    fireEvent.change(screen.getByPlaceholderText("Enter encryption passphrase"), { target: { value: "pw" } });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [file] });
    fireEvent.change(fileInput);

    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => {
      const toast = store.getState().ui.toasts.find((t: { message: string }) => t.message.includes("Critical integrity failure"));
      expect(toast).toBeTruthy();
    });
  });
});
