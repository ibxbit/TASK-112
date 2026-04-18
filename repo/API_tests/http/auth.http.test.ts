/**
 * HTTP endpoint tests — auth surface.
 *
 * Strict rules enforced here:
 *   - Real METHOD + PATH, hit with `fetch` against a real `http.Server`.
 *   - Zero `vi.mock` / `vi.spyOn`. No resolver overrides in-test.
 *   - The harness sets the DAL resolver from the Bearer token the same way
 *     a production backend would — no per-test plumbing.
 *
 * The harness lives in `src/server/httpServer.ts` and is described as an
 * audit/test harness in the README. Every route calls the production
 * modules directly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type ServerHandle } from "../../src/server/httpServer";
import { db } from "../../src/db/schema";

let server: ServerHandle;

const resetAllTables = async (): Promise<void> => {
  for (const table of db.tables) {
    await table.clear();
  }
};

beforeEach(async () => {
  await resetAllTables();
  server = await createServer();
});

afterEach(async () => {
  await server.close();
});

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${server.url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const get = (path: string, token?: string) =>
  fetch(`${server.url}${path}`, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

describe("POST /api/auth/bootstrap", () => {
  it("creates the first administrator (201) and returns the new user id", async () => {
    const res = await post("/api/auth/bootstrap", {
      username: "administrator",
      password: "Admin1234Pw!",
      displayName: "Root",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { userId: number; created: boolean; username: string };
    expect(body.created).toBe(true);
    expect(body.username).toBe("administrator");
    expect(typeof body.userId).toBe("number");

    // Observable persistence: Dexie now has a user row with role=administrator.
    const users = await db.users.toArray();
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe("administrator");
    expect(users[0].mustResetPassword).toBe(true);
  });

  it("is idempotent: calling bootstrap twice returns 200 and does not create a second admin", async () => {
    await post("/api/auth/bootstrap", { username: "administrator", password: "Admin1234Pw!" });
    const res2 = await post("/api/auth/bootstrap", { username: "administrator", password: "Other1234Pw!" });
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { created: boolean };
    expect(body.created).toBe(false);

    const users = await db.users.toArray();
    expect(users).toHaveLength(1);
  });

  it("rejects a missing password with 400 / VAL_STRING_REQUIRED", async () => {
    const res = await post("/api/auth/bootstrap", { username: "administrator" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; retryable: boolean };
    expect(body.code).toBe("VAL_STRING_REQUIRED");
    expect(body.retryable).toBe(false);
  });
});

describe("POST /api/auth/login", () => {
  beforeEach(async () => {
    await post("/api/auth/bootstrap", { username: "administrator", password: "Admin1234Pw!" });
  });

  it("returns 200 + bearer token + user payload on valid credentials", async () => {
    const res = await post("/api/auth/login", { username: "administrator", password: "Admin1234Pw!" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      user: { id: number; username: string; role: string; displayName: string | null; mustResetPassword: boolean };
    };
    expect(body.token).toMatch(/^tok_/);
    expect(body.user.username).toBe("administrator");
    expect(body.user.role).toBe("administrator");
    expect(body.user.mustResetPassword).toBe(true);
  });

  it("rejects wrong password with 403 AUTH_INVALID (retryable=false)", async () => {
    const res = await post("/api/auth/login", { username: "administrator", password: "WrongPw!" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; retryable: boolean };
    expect(body.code).toBe("AUTH_INVALID");
    expect(body.retryable).toBe(false);
  });

  it("rejects unknown username with 403 AUTH_INVALID (no user enumeration)", async () => {
    const res = await post("/api/auth/login", { username: "ghost", password: "Whatever123!" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("AUTH_INVALID");
  });

  it("rejects malformed body with 400", async () => {
    const res = await post("/api/auth/login", { username: "" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/reset-password", () => {
  let token = "";

  beforeEach(async () => {
    await post("/api/auth/bootstrap", { username: "administrator", password: "Admin1234Pw!" });
    const res = await post("/api/auth/login", { username: "administrator", password: "Admin1234Pw!" });
    token = ((await res.json()) as { token: string }).token;
  });

  it("401 when called without a bearer token", async () => {
    const res = await post("/api/auth/reset-password", { currentPassword: "Admin1234Pw!", nextPassword: "NewPassw0rd!" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_REQUIRED");
  });

  it("400 when next password is shorter than 10 chars (VAL_PASSWORD_TOO_SHORT)", async () => {
    const res = await post(
      "/api/auth/reset-password",
      { currentPassword: "Admin1234Pw!", nextPassword: "short" },
      token,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("VAL_PASSWORD_TOO_SHORT");
  });

  it("403 AUTH_INVALID when current password is wrong, persisted hash unchanged", async () => {
    const before = await db.users.toArray();
    const res = await post(
      "/api/auth/reset-password",
      { currentPassword: "WrongCurrent", nextPassword: "BrandNewPw!23" },
      token,
    );
    expect(res.status).toBe(403);
    const after = await db.users.toArray();
    expect(after[0].passwordHash).toBe(before[0].passwordHash);
    expect(after[0].salt).toBe(before[0].salt);
  });

  it("200 on valid rotation — stored hash rotates and new password now logs in", async () => {
    const before = await db.users.toArray();
    const rotate = await post(
      "/api/auth/reset-password",
      { currentPassword: "Admin1234Pw!", nextPassword: "BrandNewPw!23" },
      token,
    );
    expect(rotate.status).toBe(200);
    const after = await db.users.toArray();
    expect(after[0].passwordHash).not.toBe(before[0].passwordHash);
    expect(after[0].salt).not.toBe(before[0].salt);
    expect(after[0].mustResetPassword).toBe(false);

    // The new password is accepted by a fresh login.
    const relogin = await post("/api/auth/login", { username: "administrator", password: "BrandNewPw!23" });
    expect(relogin.status).toBe(200);
  });
});

describe("GET /api/me", () => {
  it("401 without token, 200 echoing the session owner with token", async () => {
    await post("/api/auth/bootstrap", { username: "administrator", password: "Admin1234Pw!" });
    const login = await post("/api/auth/login", { username: "administrator", password: "Admin1234Pw!" });
    const { token } = (await login.json()) as { token: string };

    const unauth = await get("/api/me");
    expect(unauth.status).toBe(401);

    const me = await get("/api/me", token);
    expect(me.status).toBe(200);
    const body = (await me.json()) as { userId: number; username: string; role: string };
    expect(body.username).toBe("administrator");
    expect(body.role).toBe("administrator");
  });
});

describe("POST /api/auth/logout", () => {
  it("204 revokes the session so follow-up /api/me returns 401", async () => {
    await post("/api/auth/bootstrap", { username: "administrator", password: "Admin1234Pw!" });
    const login = await post("/api/auth/login", { username: "administrator", password: "Admin1234Pw!" });
    const { token } = (await login.json()) as { token: string };

    const logout = await post("/api/auth/logout", {}, token);
    expect(logout.status).toBe(204);

    const after = await get("/api/me", token);
    expect(after.status).toBe(401);
  });
});
