/**
 * HTTP endpoint tests — task resource.
 *
 * Unmocked. Real server, real Dexie, real DAL business rules.
 * Auth is established the real way: POST /api/auth/bootstrap, then
 * POST /api/auth/login, then the bearer token is carried on every call
 * that requires one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type ServerHandle } from "../../src/server/httpServer";
import { db } from "../../src/db/schema";
import { authService } from "../../src/services/AuthService";

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

const request = (method: string, path: string, body?: unknown, token?: string) =>
  fetch(`${server.url}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const loginAs = async (username: string, password: string): Promise<string> => {
  const res = await request("POST", "/api/auth/login", { username, password });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status}`);
  }
  return ((await res.json()) as { token: string }).token;
};

const createUserDirect = async (username: string, role: string, password = "Welcome2026!"): Promise<void> => {
  // Seed a non-admin user directly in Dexie — the HTTP bootstrap endpoint
  // only provisions administrators; the real SPA provisions other roles
  // via the Admin Console, which calls `dal.registerLocalUser`. We invoke
  // the same service here (still unmocked) from the test side.
  const material = await authService.generateCredentialMaterial(password);
  await db.users.add({
    username,
    displayName: username,
    badgeId: `0000-${username.slice(0, 4).padEnd(4, "X")}`,
    role: role as "administrator" | "dispatcher" | "facilitator" | "operator" | "viewer" | "auditor",
    mustResetPassword: false,
    createdAt: new Date().toISOString(),
    ...material,
  });
};

const bootstrapAndLoginAdmin = async (): Promise<string> => {
  await request("POST", "/api/auth/bootstrap", { username: "administrator", password: "Admin1234Pw!" });
  // The bootstrapped admin has mustResetPassword=true but login still
  // returns a token — the reset happens via /api/auth/reset-password.
  const login = await request("POST", "/api/auth/login", { username: "administrator", password: "Admin1234Pw!" });
  return ((await login.json()) as { token: string }).token;
};

describe("GET /api/tasks", () => {
  it("401 without a bearer token", async () => {
    const res = await request("GET", "/api/tasks");
    expect(res.status).toBe(401);
  });

  it("200 with an empty list for a fresh database", async () => {
    const token = await bootstrapAndLoginAdmin();
    const res = await request("GET", "/api/tasks", undefined, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; count: number };
    expect(body.items).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("returns tasks created via POST, filtered by ?workstream", async () => {
    const token = await bootstrapAndLoginAdmin();
    const t1 = await request("POST", "/api/tasks", { title: "pickA", workstream: "picking", status: "open", priority: 3 }, token);
    expect(t1.status).toBe(201);
    const t2 = await request("POST", "/api/tasks", { title: "transA", workstream: "transport", status: "open", priority: 2 }, token);
    expect(t2.status).toBe(201);

    const all = await request("GET", "/api/tasks", undefined, token);
    expect(((await all.json()) as { count: number }).count).toBe(2);

    const pickingOnly = await request("GET", "/api/tasks?workstream=picking", undefined, token);
    const body = (await pickingOnly.json()) as { items: Array<{ title: string; workstream: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("pickA");
    expect(body.items[0].workstream).toBe("picking");
  });
});

describe("POST /api/tasks", () => {
  it("201 persists a task and returns its id", async () => {
    const token = await bootstrapAndLoginAdmin();
    const res = await request(
      "POST",
      "/api/tasks",
      { title: "inspect-line-b", workstream: "transport", status: "open", priority: 2 },
      token,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; title: string; status: string };
    expect(typeof body.id).toBe("number");
    expect(body.title).toBe("inspect-line-b");

    const persisted = await db.tasks.get(body.id);
    expect(persisted?.title).toBe("inspect-line-b");
    expect(persisted?.workstream).toBe("transport");
  });

  it("400 VAL_STRING_REQUIRED when title is missing", async () => {
    const token = await bootstrapAndLoginAdmin();
    const res = await request("POST", "/api/tasks", { workstream: "transport" }, token);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("VAL_STRING_REQUIRED");
  });

  it("403 AUTH_403 when a viewer attempts to create a task (retryable=false)", async () => {
    await bootstrapAndLoginAdmin();
    await createUserDirect("viewer-demo", "viewer");

    const viewerToken = await loginAs("viewer-demo", "Welcome2026!");
    const res = await request("POST", "/api/tasks", { title: "denied" }, viewerToken);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; retryable: boolean };
    expect(body.code).toBe("AUTH_403");
    expect(body.retryable).toBe(false);

    // Observable: no task row written.
    const rows = await db.tasks.toArray();
    expect(rows).toHaveLength(0);
  });
});

describe("GET /api/tasks/:id", () => {
  it("404 TASK_404 for an unknown id", async () => {
    const token = await bootstrapAndLoginAdmin();
    const res = await request("GET", "/api/tasks/99999", undefined, token);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("TASK_404");
  });

  it("400 VAL_INTEGER_REQUIRED when id is not an integer", async () => {
    const token = await bootstrapAndLoginAdmin();
    const res = await request("GET", "/api/tasks/not-a-number", undefined, token);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("VAL_INTEGER_REQUIRED");
  });

  it("200 returns the persisted task when id is valid and owned by the caller", async () => {
    const token = await bootstrapAndLoginAdmin();
    const create = await request("POST", "/api/tasks", { title: "fetchable" }, token);
    const { id } = (await create.json()) as { id: number };

    const fetched = await request("GET", `/api/tasks/${id}`, undefined, token);
    expect(fetched.status).toBe(200);
    const body = (await fetched.json()) as { title: string };
    expect(body.title).toBe("fetchable");
  });
});
