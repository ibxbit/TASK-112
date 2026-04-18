import { beforeEach, describe, expect, it } from "vitest";
import { dal, setDALAuthResolver } from "../src/db/dal";
import { db } from "../src/db/schema";

const clearTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

describe("registration security", () => {
  beforeEach(async () => {
    await clearTables();
  });

  it("forces self-registered admin request to viewer role", async () => {
    setDALAuthResolver(() => ({
      isAuthenticated: false,
      userId: null,
      username: null,
      role: null,
    }));

    const userId = await dal.registerLocalUser({
      username: "attacker",
      displayName: "Attacker",
      passwordHash: "x",
      salt: "y",
      iterations: 120000,
      role: "administrator",
      mustResetPassword: true,
    });

    const user = await dal.getUserById(userId);
    expect(user?.role).toBe("viewer");
  });
});
