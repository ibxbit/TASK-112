import { backupService } from "../services/BackupService";
import { WOGCError } from "./errors";

export const exportEncryptedBackup = async (passphrase: string): Promise<string> => {
  const trimmed = passphrase.trim();
  if (!trimmed) {
    throw new WOGCError({
      code: "VAL_BACKUP_PASSPHRASE_REQUIRED",
      message: "Backup passphrase is required",
      context: {},
      retryable: false,
    });
  }
  if (trimmed.length < 10) {
    throw new WOGCError({
      code: "VAL_BACKUP_PASSPHRASE_WEAK",
      message: "Backup passphrase must be at least 10 characters",
      context: { minLength: 10 },
      retryable: false,
    });
  }
  return backupService.exportEncrypted(trimmed);
};
