import { beforeEach, describe, expect, it } from "vitest";
import { authService } from "../src/services/AuthService";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { db } from "../src/db/schema";

const clearTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

describe("bootstrap hardening", () => {
  beforeEach(async () => {
    await clearTables();
    setDALAuthResolver(() => ({
      isAuthenticated: false,
      userId: null,
      username: null,
      role: null,
    }));
  });

  it("does not authenticate published default credentials on fresh state", async () => {
    await expect(authService.authenticateUser("administrator", "Admin@12345")).rejects.toThrowError("Invalid credentials");
    await expect(authService.authenticateUser("auditor", "Audit@12345")).rejects.toThrowError("Invalid credentials");
  });

  it("authenticates only explicitly bootstrapped administrator credential", async () => {
    const material = await authService.generateCredentialMaterial("SecureAdminPass123");
    const seeded = await dal.ensureAdminSeed({
      username: "administrator",
      displayName: "System Administrator",
      temporaryPasswordHash: material.passwordHash,
      salt: material.salt,
      iterations: material.iterations,
    });
    expect(seeded.created).toBe(true);

    await expect(authService.authenticateUser("administrator", "Admin@12345")).rejects.toThrowError("Invalid credentials");
    await expect(authService.authenticateUser("administrator", "SecureAdminPass123")).resolves.toMatchObject({
      username: "administrator",
      role: "administrator",
      mustResetPassword: true,
    });
  });
});
