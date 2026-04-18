import { type CSSProperties, useState } from "react";
import { backupService } from "../services/BackupService";
import { WOGCError } from "../utils/errors";
import { useToast } from "../hooks/useToast";

type ExportModalProps = {
  open: boolean;
  onClose: () => void;
};

const secureErrorMessage = (error: WOGCError): string => {
  if (error.code !== "CRYPTO_ERR") {
    return error.message;
  }
  const file = typeof error.context.file === "string" ? error.context.file : "unknown";
  return `Crypto operation failed for file: ${file}`;
};

export default function ExportModal({ open, onClose }: ExportModalProps): JSX.Element | null {
  const toast = useToast();
  const [passphrase, setPassphrase] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return null;
  }

  const runExport = async (): Promise<void> => {
    setBusy(true);
    setStatus(null);
    try {
      const file = await backupService.exportEncrypted(passphrase);
      setStatus(`Encrypted backup exported: ${file}`);
      toast.success("Encrypted backup exported.");
    } catch (error) {
      if (error instanceof WOGCError) {
        setStatus(secureErrorMessage(error));
        toast.fromError(error, "Export failed unexpectedly.");
      } else {
        setStatus("Export failed unexpectedly.");
        toast.error("Export failed unexpectedly.");
      }
    } finally {
      setBusy(false);
    }
  };

  const runImport = async (): Promise<void> => {
    if (!importFile) {
      setStatus("Select an encrypted backup file first.");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await backupService.importEncrypted(importFile, passphrase);
      setStatus(`Encrypted backup imported: ${importFile.name}`);
      toast.success("Encrypted backup imported.");
    } catch (error) {
      if (error instanceof WOGCError) {
        setStatus(secureErrorMessage(error));
        if (error.code === "AUDIT_INTEGRITY_FAIL") {
          toast.error("Critical integrity failure: audit history import rejected.");
        } else {
          toast.fromError(error, "Import failed unexpectedly.");
        }
      } else {
        setStatus("Import failed unexpectedly.");
        toast.error("Import failed unexpectedly.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="Encrypted Backup">
      <section style={panel}>
        <h3 style={{ marginTop: 0 }}>Encrypted Backup</h3>
        <p style={{ marginTop: 0, color: "#4e5968" }}>Export/import Dexie data as AES-GCM encrypted JSON bundle.</p>

        <label style={labelStyle}>
          Passphrase
          <input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            style={inputStyle}
            placeholder="Enter encryption passphrase"
          />
        </label>

        <label style={labelStyle}>
          Import File
          <input type="file" accept="application/json" onChange={(event) => setImportFile(event.target.files?.[0] ?? null)} />
        </label>

        {status ? <p style={{ margin: 0, background: "#eef3f9", padding: "0.45rem" }}>{status}</p> : null}

        <div style={{ marginTop: "0.75rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <button type="button" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button type="button" onClick={() => void runImport()} disabled={busy || !passphrase}>
            Import
          </button>
          <button type="button" onClick={() => void runExport()} disabled={busy || !passphrase}>
            Export
          </button>
        </div>
      </section>
    </div>
  );
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(18, 26, 39, 0.42)",
  display: "grid",
  placeItems: "center",
  zIndex: 60,
};

const panel: CSSProperties = {
  width: "min(36rem, 94vw)",
  background: "#fff",
  border: "1px solid #cad2dd",
  borderRadius: "0.6rem",
  padding: "1rem",
};

const labelStyle: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
  marginBottom: "0.65rem",
};

const inputStyle: CSSProperties = {
  border: "1px solid #a9b2be",
  borderRadius: "0.4rem",
  padding: "0.45rem",
};
