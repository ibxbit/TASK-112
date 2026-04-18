import saveAs from "file-saver";
import { db, type UserRole } from "../db/schema";
import { WOGCError } from "../utils/errors";
import { logger } from "../utils/logger";

const BACKUP_FILENAME = `wogc-backup-${new Date().toISOString().slice(0, 10)}.enc.json`;
const PBKDF2_ITERATIONS = 120000;

type EncryptedBackup = {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iter: number;
  salt: string;
  iv: string;
  data: string;
};

type BackupPayload = {
  exportedAt: string;
  tables: Record<string, unknown[]>;
};

type AuditImportValidation = {
  ok: boolean;
  reason?: string;
};

const toBase64 = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return btoa(out);
};

const fromBase64 = (value: string): Uint8Array => {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
};

// WebCrypto accepts any BufferSource (ArrayBufferView or ArrayBuffer), so
// passing Uint8Array directly is spec-compliant and avoids the cross-realm
// ArrayBuffer rejection seen when feeding `.buffer.slice(...)` produced in
// jsdom/DOM-land to Node's WebCrypto.

const deriveAESKey = async (passphrase: string, salt: Uint8Array): Promise<CryptoKey> => {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: salt as BufferSource,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

const listTableNames = (): string[] => [
  "users",
  "tasks",
  "equipment_heartbeats",
  "calendar_events",
  "meetings",
  "notifications",
  "user_subscriptions",
  "notification_read_receipts",
  "notification_delivery_logs",
  "calendar_capacities",
  "calendar_lockouts",
  "calendar_holds",
  "meeting_agenda_items",
  "meeting_resolutions",
  "meeting_attachments",
  "sessions",
  "system_settings",
  "permission_overrides",
  "audit_log",
  "message_outbox",
];

const digestHex = (value: string): string => {
  let h1 = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h1 ^= value.charCodeAt(i);
    h1 = Math.imul(h1, 16777619);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0");
};

const asAuditRows = (rows: unknown[]): Array<{ sequence: number; hash: string; action: string; entity: string; entityId: string; actorRole: UserRole | "anonymous"; details: Record<string, unknown>; timestamp: string; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null; actorUserId?: number; actorUsername?: string }> => {
  return rows
    .filter((row) => typeof row === "object" && row !== null)
    .map((row) => row as Record<string, unknown>)
    .filter((row) => typeof row.sequence === "number" && typeof row.hash === "string" && typeof row.action === "string" && typeof row.entity === "string" && typeof row.entityId === "string" && typeof row.actorRole === "string" && typeof row.timestamp === "string")
    .map((row) => ({
      sequence: row.sequence as number,
      hash: row.hash as string,
      action: row.action as string,
      entity: row.entity as string,
      entityId: row.entityId as string,
      actorRole: (["administrator", "dispatcher", "facilitator", "operator", "viewer", "auditor", "anonymous"] as const).includes(row.actorRole as UserRole | "anonymous")
        ? (row.actorRole as UserRole | "anonymous")
        : "anonymous",
      details: (row.details as Record<string, unknown>) ?? {},
      timestamp: row.timestamp as string,
      before: (row.before as Record<string, unknown> | null | undefined) ?? null,
      after: (row.after as Record<string, unknown> | null | undefined) ?? null,
      actorUserId: typeof row.actorUserId === "number" ? row.actorUserId : undefined,
      actorUsername: typeof row.actorUsername === "string" ? row.actorUsername : undefined,
    }));
};

const validateChain = (rows: Array<{ sequence: number; hash: string; action: string; entity: string; entityId: string; actorRole: string; details: Record<string, unknown>; timestamp: string; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null }>): AuditImportValidation => {
  const sorted = [...rows].sort((a, b) => a.sequence - b.sequence);
  let prevHash = "GENESIS";
  let prevTimestamp = "";
  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i];
    const expectedSeq = i === 0 ? sorted[0].sequence : sorted[i - 1].sequence + 1;
    if (row.sequence !== expectedSeq) {
      return { ok: false, reason: `sequence discontinuity at ${row.sequence}` };
    }
    if (prevTimestamp && row.timestamp < prevTimestamp) {
      return { ok: false, reason: `timestamp regression at sequence ${row.sequence}` };
    }
    const material = JSON.stringify({
      prevHash,
      sequence: row.sequence,
      actorRole: row.actorRole,
      action: row.action,
      entity: row.entity,
      entityId: row.entityId,
      before: row.before ?? null,
      after: row.after ?? null,
      details: row.details,
      timestamp: row.timestamp,
    });
    const expectedHash = digestHex(material);
    if (expectedHash !== row.hash) {
      return { ok: false, reason: `hash mismatch at sequence ${row.sequence}` };
    }
    prevHash = row.hash;
    prevTimestamp = row.timestamp;
  }
  return { ok: true };
};

const emitIntegrityAlert = (reason: string): void => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("wogc.integrity.alert", { detail: { reason, timestamp: new Date().toISOString() } }));
  }
  logger.error("INTEGRITY_ALERT", { reason });
};

const validateTaskPriorities = (rows: unknown[]): AuditImportValidation => {
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const value = (row as Record<string, unknown>).priority;
    if (typeof value === "undefined") {
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
      return { ok: false, reason: `invalid task priority value: ${String(value)}` };
    }
  }
  return { ok: true };
};

const appendIntegrityAudit = async (reason: string): Promise<void> => {
  const last = await db.audit_log.orderBy("sequence").last();
  const sequence = (last?.sequence ?? 0) + 1;
  const timestamp = new Date().toISOString();
  const details = { reason };
  const material = JSON.stringify({
    prevHash: last?.hash ?? "GENESIS",
    sequence,
    actorRole: "administrator",
    action: "audit.integrity_violation",
    entity: "audit_log",
    entityId: "import",
    before: null,
    after: null,
    details,
    timestamp,
  });
  await db.audit_log.add({
    sequence,
    hash: digestHex(material),
    action: "audit.integrity_violation",
    entity: "audit_log",
    entityId: "import",
    actorRole: "administrator",
    actorUsername: "system",
    details,
    timestamp,
  });
};

const collectPayload = async (): Promise<BackupPayload> => {
  const tables: Record<string, unknown[]> = {};
  for (const table of listTableNames()) {
    tables[table] = await db.table(table).toArray();
  }
  return {
    exportedAt: new Date().toISOString(),
    tables,
  };
};

class BackupService {
  public async exportEncrypted(passphrase: string): Promise<string> {
    const file = BACKUP_FILENAME;
    try {
      const payload = await collectPayload();
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveAESKey(passphrase, salt);
      const plainBytes = new TextEncoder().encode(JSON.stringify(payload));
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plainBytes as BufferSource);

      const bundle: EncryptedBackup = {
        v: 1,
        kdf: "PBKDF2-SHA256",
        iter: PBKDF2_ITERATIONS,
        salt: toBase64(salt),
        iv: toBase64(iv),
        data: toBase64(new Uint8Array(encrypted)),
      };

      const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
      saveAs(blob, file);
      return file;
    } catch {
      throw new WOGCError({
        code: "CRYPTO_ERR",
        message: "Encrypted backup export failed",
        context: { file },
        retryable: false,
      });
    }
  }

  public async importEncrypted(file: File, passphrase: string): Promise<void> {
    try {
      const text = await file.text();
      const bundle = JSON.parse(text) as Partial<EncryptedBackup>;
      if (!bundle.salt || !bundle.iv || !bundle.data || bundle.v !== 1) {
        throw new Error("Malformed backup file");
      }

      const salt = fromBase64(bundle.salt);
      const iv = fromBase64(bundle.iv);
      const encrypted = fromBase64(bundle.data);
      const key = await deriveAESKey(passphrase, salt);
      const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, encrypted as BufferSource);
      const payload = JSON.parse(new TextDecoder().decode(plainBuffer)) as BackupPayload;

      const importedAudit = asAuditRows(payload.tables.audit_log ?? []);
      const existingAudit = await db.audit_log.orderBy("sequence").toArray();
      const existingChain = validateChain(existingAudit as unknown as Array<{ sequence: number; hash: string; action: string; entity: string; entityId: string; actorRole: string; details: Record<string, unknown>; timestamp: string; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null }>);
      if (!existingChain.ok) {
        const reason = `Existing audit chain invalid: ${existingChain.reason ?? "unknown"}`;
        await appendIntegrityAudit(reason);
        emitIntegrityAlert(reason);
        throw new WOGCError({ code: "AUDIT_INTEGRITY_FAIL", message: reason, context: { file: file.name }, retryable: false });
      }

      const importedChain = validateChain(importedAudit);
      if (!importedChain.ok) {
        const reason = `Imported audit chain invalid: ${importedChain.reason ?? "unknown"}`;
        await appendIntegrityAudit(reason);
        emitIntegrityAlert(reason);
        throw new WOGCError({ code: "AUDIT_INTEGRITY_FAIL", message: reason, context: { file: file.name }, retryable: false });
      }

      const existingBySequence = new Map(existingAudit.map((row) => [row.sequence, row]));
      const importedBySequence = new Map(importedAudit.map((row) => [row.sequence, row]));
      for (const row of existingAudit) {
        const imported = importedBySequence.get(row.sequence);
        if (!imported) {
          const reason = `Imported backup attempts to remove historical audit row ${row.sequence}`;
          await appendIntegrityAudit(reason);
          emitIntegrityAlert(reason);
          throw new WOGCError({ code: "AUDIT_INTEGRITY_FAIL", message: reason, context: { file: file.name, sequence: row.sequence }, retryable: false });
        }
      }
      for (const row of importedAudit) {
        const existing = existingBySequence.get(row.sequence);
        if (existing && existing.hash !== row.hash) {
          const reason = `Immutable audit conflict at sequence ${row.sequence}`;
          await appendIntegrityAudit(reason);
          emitIntegrityAlert(reason);
          throw new WOGCError({ code: "AUDIT_INTEGRITY_FAIL", message: reason, context: { file: file.name, sequence: row.sequence }, retryable: false });
        }
      }

      const maxExistingSequence = existingAudit.length ? existingAudit[existingAudit.length - 1].sequence : 0;
      const appendRows = importedAudit.filter((row) => row.sequence > maxExistingSequence).sort((a, b) => a.sequence - b.sequence);
      if (appendRows.length > 0 && appendRows[0].sequence !== maxExistingSequence + 1) {
        const reason = "Imported audit rows are not append-contiguous";
        await appendIntegrityAudit(reason);
        emitIntegrityAlert(reason);
          throw new WOGCError({ code: "AUDIT_INTEGRITY_FAIL", message: reason, context: { file: file.name }, retryable: false });
      }

      const latestExisting = existingAudit[existingAudit.length - 1];
      if (latestExisting && appendRows[0] && appendRows[0].timestamp < latestExisting.timestamp) {
        const reason = "Imported audit timestamps regress before current history";
        await appendIntegrityAudit(reason);
        emitIntegrityAlert(reason);
        throw new WOGCError({ code: "AUDIT_INTEGRITY_FAIL", message: reason, context: { file: file.name }, retryable: false });
      }

      const priorityValidation = validateTaskPriorities(payload.tables.tasks ?? []);
      if (!priorityValidation.ok) {
        const reason = `Imported tasks invalid: ${priorityValidation.reason ?? "unknown"}`;
        await appendIntegrityAudit(reason);
        emitIntegrityAlert(reason);
        throw new WOGCError({ code: "AUDIT_INTEGRITY_FAIL", message: reason, context: { file: file.name }, retryable: false });
      }

      await db.transaction("rw", db.tables, async () => {
        for (const row of appendRows) {
          await db.audit_log.add(row);
        }

        for (const tableName of listTableNames()) {
          if (tableName === "audit_log") {
            continue;
          }
          const rows = payload.tables[tableName] ?? [];
          const table = db.table(tableName);
          for (const row of rows) {
            await table.put(row as Record<string, unknown>);
          }
        }
      });
    } catch (error) {
      if (error instanceof WOGCError) {
        throw error;
      }
      throw new WOGCError({
        code: "CRYPTO_ERR",
        message: "Encrypted backup import failed",
        context: { file: file.name },
        retryable: false,
      });
    }
  }
}

export const backupService = new BackupService();
