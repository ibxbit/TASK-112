import { dal } from "../db/dal";
import { db, type UserProfileRecord, type UserRecord } from "../db/schema";
import { WOGCError } from "../utils/errors";

const PBKDF2_ITERATIONS = 120000;
const PBKDF2_HASH = "SHA-256";

const bytesToBase64 = (bytes: Uint8Array): string => {
  let output = "";
  for (let i = 0; i < bytes.length; i += 1) {
    output += String.fromCharCode(bytes[i]);
  }
  return btoa(output);
};

const base64ToBytes = (value: string): Uint8Array => {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
};

const derivePasswordHash = async (password: string, salt: Uint8Array, iterations: number): Promise<string> => {
  // `salt` is an ArrayBufferView (Uint8Array), which IS a BufferSource and
  // is accepted directly by WebCrypto. A prior version of this function
  // called `.buffer.slice(...)` first, producing an ArrayBuffer that
  // WebCrypto rejects across jsdom↔Node realm boundaries. Passing the
  // Uint8Array directly is spec-compliant and works on every runtime.
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: PBKDF2_HASH,
      iterations,
      salt: salt as BufferSource,
    },
    keyMaterial,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
};

const stripCredentialFields = (record: UserRecord & { id: number }): UserProfileRecord & { id: number } => {
  const { passwordHash: _passwordHash, salt: _salt, iterations: _iterations, ...profile } = record;
  return profile;
};

type UserCredentialRecord = UserRecord & { id: number };

class AuthService {
  public normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
  }

  public async getProfileByUsername(username: string): Promise<(UserProfileRecord & { id: number }) | null> {
    const normalized = this.normalizeUsername(username);
    if (!normalized) {
      return null;
    }
    const profile = await dal.getUserProfileByUsername(normalized);
    if (!profile || typeof profile.id !== "number") {
      return null;
    }
    if (typeof profile.id !== "number") {
      return null;
    }
    return profile as UserProfileRecord & { id: number };
  }

  public async ensureUsernameAvailable(username: string): Promise<boolean> {
    const normalized = this.normalizeUsername(username);
    if (!normalized) {
      return false;
    }
    const row = await db.users.where("username").equals(normalized).first();
    return !row;
  }

  public async generateCredentialMaterial(password: string): Promise<{ passwordHash: string; salt: string; iterations: number }> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const passwordHash = await derivePasswordHash(password, salt, PBKDF2_ITERATIONS);
    return {
      passwordHash,
      salt: bytesToBase64(salt),
      iterations: PBKDF2_ITERATIONS,
    };
  }

  public async authenticateUser(username: string, plainTextPassword: string): Promise<UserProfileRecord & { id: number }> {
    const normalized = this.normalizeUsername(username);
    if (!normalized) {
      throw new Error("Invalid credentials");
    }

    const record = await this.getCredentialRecordByUsername(normalized);
    if (!record) {
      throw new Error("Invalid credentials");
    }

    const derived = await derivePasswordHash(plainTextPassword, base64ToBytes(record.salt), record.iterations || PBKDF2_ITERATIONS);
    if (derived !== record.passwordHash) {
      throw new Error("Invalid credentials");
    }

    return stripCredentialFields(record);
  }

  public async login(username: string, password: string): Promise<UserProfileRecord & { id: number }> {
    return this.authenticateUser(username, password);
  }

  public async verifyCurrentPasswordAndRotate(userId: number, currentPassword: string, nextPassword: string): Promise<void> {
    const record = await this.getCredentialRecordById(userId);
    if (!record) {
      throw new WOGCError({
        code: "USER_404",
        message: "User not found",
        context: { userId },
        retryable: false,
      });
    }
    const currentHash = await derivePasswordHash(currentPassword, base64ToBytes(record.salt), record.iterations || PBKDF2_ITERATIONS);
    if (currentHash !== record.passwordHash) {
      throw new WOGCError({
        code: "AUTH_INVALID",
        message: "Current password is invalid",
        context: { userId },
        retryable: false,
      });
    }
    const rotated = await this.generateCredentialMaterial(nextPassword);
    await dal.updateUserPassword({
      userId,
      passwordHash: rotated.passwordHash,
      salt: rotated.salt,
      iterations: rotated.iterations,
      mustResetPassword: false,
    });
  }

  private async getCredentialRecordByUsername(username: string): Promise<UserCredentialRecord | null> {
    const row = await db.users.where("username").equals(username).first();
    if (!row || typeof row.id !== "number") {
      return null;
    }
    return row as UserCredentialRecord;
  }

  private async getCredentialRecordById(userId: number): Promise<UserCredentialRecord | null> {
    const row = await db.users.get(userId);
    if (!row || typeof row.id !== "number") {
      return null;
    }
    return row as UserCredentialRecord;
  }
}

export const authService = new AuthService();
