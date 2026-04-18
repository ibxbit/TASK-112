import { beforeEach, describe, expect, it, vi } from "vitest";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { db } from "../src/db/schema";
import { backupService } from "../src/services/BackupService";
import { WOGCError } from "../src/utils/errors";
import { logger } from "../src/utils/logger";

const clearTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

const PBKDF2_ITERATIONS = 120000;

const toBase64 = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return btoa(out);
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const deriveAESKey = async (passphrase: string, salt: Uint8Array): Promise<CryptoKey> => {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: toArrayBuffer(salt),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

const listTableNames = (): string[] => db.tables.map((table) => table.name);

const snapshotTables = async (): Promise<Record<string, unknown[]>> => {
  const out: Record<string, unknown[]> = {};
  for (const tableName of listTableNames()) {
    out[tableName] = await db.table(tableName).toArray();
  }
  return out;
};

const encryptedBackupFile = async (payload: Record<string, unknown>, passphrase: string, filename: string): Promise<File> => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAESKey(passphrase, salt);
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, plain);
  const bundle = {
    v: 1,
    kdf: "PBKDF2-SHA256",
    iter: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(encrypted)),
  };
  return new File([JSON.stringify(bundle)], filename, { type: "application/json" });
};

describe("meeting attachments", () => {
  beforeEach(async () => {
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: 7,
      username: "facilitator",
      role: "facilitator",
    }));
    await clearTables();
  });

  it("stores attachments and enforces backup integrity failure matrix with append-only success case", async () => {
    const meetingId = await dal.saveMeeting({
      subject: "Material sync",
      facilitator: "facilitator",
      minutes: "Agenda",
      signIn: ["viewer"],
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 1000 * 60).toISOString(),
    });

    const blobData = new Blob(["hello pdf"], { type: "application/pdf" });
    const attachmentId = await dal.saveAttachment({
      meetingId,
      filename: "notes.pdf",
      mimeType: "application/pdf",
      size: blobData.size,
      uploader: "facilitator",
      contentHash: "abc123",
      blobData,
    });

    const payload = await dal.getAttachmentBlob(attachmentId);
    expect(payload?.filename).toBe("notes.pdf");
    expect(payload?.mimeType).toBe("application/pdf");
    expect(await payload?.blobData.text()).toBe("hello pdf");

    const corrupted = new File(["not-json"], "corrupted.enc.json", { type: "application/json" });
    await expect(backupService.importEncrypted(corrupted, "pw")).rejects.toBeInstanceOf(WOGCError);

    const versionMismatch = new File([JSON.stringify({ v: 9, salt: "x", iv: "x", data: "x" })], "v-mismatch.enc.json", { type: "application/json" });
    await expect(backupService.importEncrypted(versionMismatch, "pw")).rejects.toBeInstanceOf(WOGCError);

    const tampered = new File([JSON.stringify({ v: 1, salt: "AAAA", iv: "AAAA", data: "AAAA" })], "tampered.enc.json", { type: "application/json" });
    await expect(backupService.importEncrypted(tampered, "pw")).rejects.toBeInstanceOf(WOGCError);

    const passphrase = "pw";
    const alertEvents: string[] = [];
    const errorSpy = vi.spyOn(logger, "error");
    const onAlert = (event: Event): void => {
      const custom = event as CustomEvent<{ reason: string }>;
      alertEvents.push(custom.detail.reason);
    };
    const canListenWindow = typeof window !== "undefined" && typeof window.addEventListener === "function";
    if (canListenWindow) {
      window.addEventListener("wogc.integrity.alert", onAlert);
    }

    const baselineTables = await snapshotTables();
    const baselineAudit = [...((baselineTables.audit_log ?? []) as Array<Record<string, unknown>>)].sort(
      (a, b) => Number(a.sequence) - Number(b.sequence),
    );
    const baselineLastSequence = Number(baselineAudit[baselineAudit.length - 1]?.sequence ?? 0);
    const baselineTaskCount = (baselineTables.tasks ?? []).length;

    const buildPayload = (auditRows: unknown[], extraTaskTitle: string): Record<string, unknown> => ({
      exportedAt: new Date().toISOString(),
      tables: {
        ...baselineTables,
        tasks: [
          ...(baselineTables.tasks ?? []),
          {
            id: 99_901,
            scopeUserId: 7,
            title: extraTaskTitle,
            status: "open",
            workstream: "putaway",
            priority: 3,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        audit_log: auditRows,
      },
    });

    const missingSequence = baselineAudit.filter((row) => Number(row.sequence) !== baselineLastSequence - 1);
    const missingSeqFile = await encryptedBackupFile(buildPayload(missingSequence, "missing-seq"), passphrase, "missing-seq.enc.json");
    await expect(backupService.importEncrypted(missingSeqFile, passphrase)).rejects.toBeInstanceOf(WOGCError);

    const tamperedChain = baselineAudit.map((row) => (Number(row.sequence) === baselineLastSequence ? { ...row, action: "tampered.action" } : row));
    const tamperedFile = await encryptedBackupFile(buildPayload(tamperedChain, "tampered-chain"), passphrase, "tampered-chain.enc.json");
    await expect(backupService.importEncrypted(tamperedFile, passphrase)).rejects.toBeInstanceOf(WOGCError);

    const previous = baselineAudit[baselineAudit.length - 1];
    const timestampRegressionRow = {
      sequence: baselineLastSequence + 1,
      hash: "will-be-invalid-anyway",
      action: "task.created",
      entity: "tasks",
      entityId: "99901",
      actorRole: "administrator",
      details: {},
      timestamp: String(previous?.timestamp ?? new Date().toISOString()).replace(/\d\d:\d\d:\d\d/, "00:00:00"),
    };
    const timestampRegressionFile = await encryptedBackupFile(
      buildPayload([...baselineAudit, timestampRegressionRow], "ts-regression"),
      passphrase,
      "ts-regression.enc.json",
    );
    await expect(backupService.importEncrypted(timestampRegressionFile, passphrase)).rejects.toBeInstanceOf(WOGCError);

    const deleteHistorical = baselineAudit.slice(1);
    const deleteFile = await encryptedBackupFile(buildPayload(deleteHistorical, "delete-history"), passphrase, "delete-history.enc.json");
    await expect(backupService.importEncrypted(deleteFile, passphrase)).rejects.toBeInstanceOf(WOGCError);

    const afterFailureTasks = await db.tasks.toArray();
    expect(afterFailureTasks.length).toBe(baselineTaskCount);
    expect(afterFailureTasks.some((row) => row.title === "missing-seq" || row.title === "tampered-chain" || row.title === "ts-regression" || row.title === "delete-history")).toBe(false);

    const auditAfterFailures = await db.audit_log.orderBy("sequence").toArray();
    expect(auditAfterFailures.some((row) => row.action === "audit.integrity_violation")).toBe(true);
    if (canListenWindow) {
      expect(alertEvents.length).toBeGreaterThan(0);
    }
    expect(errorSpy).toHaveBeenCalled();

    const appendOnlyRows = await db.audit_log.orderBy("sequence").toArray();
    const last = appendOnlyRows[appendOnlyRows.length - 1];
    const nextSequence = (last?.sequence ?? 0) + 1;
    const nextTimestamp = new Date(Date.now() + 60_000).toISOString();
    const material = JSON.stringify({
      prevHash: last?.hash ?? "GENESIS",
      sequence: nextSequence,
      actorRole: "administrator",
      action: "backup.import.appended",
      entity: "audit_log",
      entityId: "success-case",
      before: null,
      after: null,
      details: { from: "test" },
      timestamp: nextTimestamp,
    });
    let h1 = 2166136261;
    for (let i = 0; i < material.length; i += 1) {
      h1 ^= material.charCodeAt(i);
      h1 = Math.imul(h1, 16777619);
    }
    const nextHash = (h1 >>> 0).toString(16).padStart(8, "0");

    const successPayload = {
      exportedAt: new Date().toISOString(),
      tables: {
        ...(await snapshotTables()),
        tasks: [
          ...(await db.tasks.toArray()),
          {
            id: 99_999,
            scopeUserId: 7,
            title: "append-success",
            status: "open",
            workstream: "transport",
            priority: 4,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        audit_log: [
          ...appendOnlyRows,
          {
            sequence: nextSequence,
            hash: nextHash,
            action: "backup.import.appended",
            entity: "audit_log",
            entityId: "success-case",
            actorRole: "administrator",
            details: { from: "test" },
            timestamp: nextTimestamp,
          },
        ],
      },
    };
    const successFile = await encryptedBackupFile(successPayload, passphrase, "success.enc.json");
    await expect(backupService.importEncrypted(successFile, passphrase)).resolves.toBeUndefined();

    const postSuccessAudit = await db.audit_log.orderBy("sequence").toArray();
    expect(postSuccessAudit.some((row) => row.sequence === nextSequence && row.action === "backup.import.appended")).toBe(true);
    const postSuccessTasks = await db.tasks.toArray();
    expect(postSuccessTasks.some((row) => row.title === "append-success")).toBe(true);

    if (canListenWindow) {
      window.removeEventListener("wogc.integrity.alert", onAlert);
    }
    errorSpy.mockRestore();
  });
});
