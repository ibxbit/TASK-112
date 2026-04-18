/**
 * Service-boundary coverage for the password rotation path that the UI
 * component test could not exercise end-to-end under jsdom (jsdom ships a
 * partial WebCrypto shim that rejects sliced ArrayBuffer salts). This test
 * runs under the node environment where the real WebCrypto is available,
 * so it drives the full production code path — PBKDF2 generate, verify,
 * rotate, audit — without any mocks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/schema";
import { authService } from "../src/services/AuthService";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { WOGCError } from "../src/utils/errors";

let currentUserId = 0;

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
  // Resolver reads `currentUserId` from closure so tests that re-seed get the
  // actual primary-key value Dexie assigned (auto-increment counter survives
  // a `.clear()`). This keeps the `selfServe` branch in DAL.updateUserPassword
  // working without granting role.write=users.
  setDALAuthResolver(() => ({
    isAuthenticated: currentUserId > 0,
    userId: currentUserId || null,
    username: currentUserId ? "alice" : null,
    role: currentUserId ? "dispatcher" : null,
  }));
});

afterEach(() => {
  currentUserId = 0;
});

const seed = async (password: string) => {
  const material = await authService.generateCredentialMaterial(password);
  const id = await db.users.add({
    username: "alice",
    displayName: "Alice",
    badgeId: "0001-0002",
    role: "dispatcher",
    mustResetPassword: true,
    createdAt: new Date().toISOString(),
    ...material,
  });
  currentUserId = id as number;
  return id as number;
};

describe("Password rotation service boundary", () => {
  it("authenticateUser succeeds with the seeded password and rejects the wrong one", async () => {
    await seed("CurrentLongPw9");
    const ok = await authService.authenticateUser("alice", "CurrentLongPw9");
    expect(ok.username).toBe("alice");
    await expect(authService.authenticateUser("alice", "WrongPassw0rd")).rejects.toBeInstanceOf(Error);
  });

  it("verifyCurrentPasswordAndRotate rotates the stored hash/salt on success, flips mustResetPassword to false", async () => {
    const id = await seed("CurrentLongPw9");
    const before = await db.users.get(id);

    await authService.verifyCurrentPasswordAndRotate(id, "CurrentLongPw9", "BrandNewPw!23");

    const after = await db.users.get(id);
    expect(after?.passwordHash).not.toBe(before?.passwordHash);
    expect(after?.salt).not.toBe(before?.salt);
    expect(after?.mustResetPassword).toBe(false);

    // And the new password is now accepted by authenticateUser (end-to-end).
    const reauth = await authService.authenticateUser("alice", "BrandNewPw!23");
    expect(reauth.id).toBe(id);
  });

  it("rejects rotation when the supplied current password is wrong, without touching persisted hash", async () => {
    const id = await seed("RealCurrentPw9");
    const before = await db.users.get(id);

    await expect(
      authService.verifyCurrentPasswordAndRotate(id, "WrongCurrentPw", "BrandNewPw!23"),
    ).rejects.toMatchObject({ code: "AUTH_INVALID", retryable: false });

    const after = await db.users.get(id);
    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect(after?.salt).toBe(before?.salt);
    expect(after?.mustResetPassword).toBe(true);
  });

  it("rotation of a missing user surfaces USER_404 (non-retryable contract)", async () => {
    await expect(
      authService.verifyCurrentPasswordAndRotate(9999, "whatever", "NewValidPw!1"),
    ).rejects.toMatchObject({ code: "USER_404", retryable: false });
  });

  it("updateUserPassword via DAL appends an audit row reflecting the rotation", async () => {
    const id = await seed("OldPasswordOk1");

    await authService.verifyCurrentPasswordAndRotate(id, "OldPasswordOk1", "FreshPassw0rd!");

    // Switch to administrator for audit read access (RBAC contract).
    setDALAuthResolver(() => ({
      isAuthenticated: true,
      userId: currentUserId,
      username: "admin",
      role: "administrator",
    }));
    const entries = await dal.listAuditTrail({});
    const pwdAudit = entries.find((e) => e.action.includes("password") || e.entity === "users");
    expect(pwdAudit).toBeTruthy();
  });

  it("double-hashing is not possible: reseeded salt yields a different hash than the old one for the same plaintext", async () => {
    const mat1 = await authService.generateCredentialMaterial("SamePassword1!");
    const mat2 = await authService.generateCredentialMaterial("SamePassword1!");
    expect(mat1.salt).not.toBe(mat2.salt);
    expect(mat1.passwordHash).not.toBe(mat2.passwordHash);
  });

  // The only assertion this file intentionally does NOT re-cover is the UI
  // `mustResetPassword` Redux state transition — that is covered in
  // `unit_tests/pages_passwordReset.test.tsx` where the component renders.
  // Splitting the responsibility keeps crypto out of the DOM harness and
  // UI state out of the service harness.
  it("placeholder assertion to document the split responsibility", () => {
    expect(typeof WOGCError).toBe("function");
  });
});
