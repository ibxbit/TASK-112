/**
 * HTTP endpoint tests — governance surface: /api/audit, /api/dlq, /api/health.
 *
 * Unmocked. Real Dexie. Real DAL RBAC. Real event bus.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type ServerHandle } from "../../src/server/httpServer";
import { db } from "../../src/db/schema";
import { authService } from "../../src/services/AuthService";
import { eventBus } from "../../src/services/EventBus";

let server: ServerHandle;

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
  await eventBus.clearProcessedRegistry();
  server = await createServer();
});

afterEach(async () => {
  await server.close();
});

const req = (method: string, path: string, body?: unknown, token?: string) =>
  fetch(`${server.url}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const seedUser = async (username: string, role: string, password = "Welcome2026!") => {
  const material = await authService.generateCredentialMaterial(password);
  await db.users.add({
    username,
    displayName: username,
    badgeId: `000${username.length}-${username.slice(0, 4).padEnd(4, "X")}`,
    role: role as Parameters<typeof db.users.add>[0]["role"],
    mustResetPassword: false,
    createdAt: new Date().toISOString(),
    ...material,
  });
};

const login = async (username: string, password: string): Promise<string> => {
  const res = await req("POST", "/api/auth/login", { username, password });
  return ((await res.json()) as { token: string }).token;
};

const bootstrapAdmin = async () => {
  await req("POST", "/api/auth/bootstrap", { username: "administrator", password: "Admin1234Pw!" });
  return login("administrator", "Admin1234Pw!");
};

describe("GET /api/health", () => {
  it("200 without auth, exposes DLQ depth and status=ok", async () => {
    const res = await req("GET", "/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; dlqDepth: number };
    expect(body.status).toBe("ok");
    expect(body.dlqDepth).toBe(0);
  });

  it("reflects a growing DLQ depth when events fail 5 times", async () => {
    await bootstrapAdmin();
    // Subscribe a failing consumer so the event bus promotes the envelope
    // to the real DLQ on retryCount>=5.
    const unsub = eventBus.subscribe(
      "tasks.expired",
      () => {
        throw new Error("forced-failure");
      },
      { consumerId: "http.governance.force-dlq" },
    );
    await eventBus.publishEnvelope({
      id: "evt-for-dlq",
      type: "tasks.expired",
      payload: { taskIds: [1], expiredAt: new Date().toISOString() },
      emittedAt: new Date().toISOString(),
      retryCount: 5,
    });

    const res = await req("GET", "/api/health");
    const body = (await res.json()) as { dlqDepth: number };
    expect(body.dlqDepth).toBeGreaterThan(0);
    unsub();
  });
});

describe("GET /api/audit", () => {
  it("401 without token", async () => {
    const res = await req("GET", "/api/audit");
    expect(res.status).toBe(401);
  });

  it("200 returns audit rows for administrator, filtered by ?entity", async () => {
    const token = await bootstrapAdmin();
    // Generate an audit row via a real task create.
    await req("POST", "/api/tasks", { title: "audit-me", workstream: "transport" }, token);

    const unfiltered = await req("GET", "/api/audit", undefined, token);
    expect(unfiltered.status).toBe(200);
    const all = (await unfiltered.json()) as { count: number; items: Array<{ entity: string }> };
    expect(all.count).toBeGreaterThan(0);

    const filtered = await req("GET", "/api/audit?entity=tasks", undefined, token);
    const body = (await filtered.json()) as { items: Array<{ entity: string }>; count: number };
    expect(body.count).toBeGreaterThan(0);
    for (const row of body.items) {
      expect(row.entity).toBe("tasks");
    }
  });

  it("403 AUTH_403 when a dispatcher (not admin/auditor) asks for audit", async () => {
    await bootstrapAdmin();
    await seedUser("disp", "dispatcher");
    const dispToken = await login("disp", "Welcome2026!");

    const res = await req("GET", "/api/audit", undefined, dispToken);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_403");
  });

  it("200 auditor role can read audit trail but cannot mutate", async () => {
    await bootstrapAdmin();
    await seedUser("audit-demo", "auditor");
    const token = await login("audit-demo", "Welcome2026!");

    const res = await req("GET", "/api/audit", undefined, token);
    expect(res.status).toBe(200);

    // And auditors cannot create tasks (DAL denies at the boundary).
    const writeAttempt = await req("POST", "/api/tasks", { title: "forbidden" }, token);
    expect(writeAttempt.status).toBe(403);
  });
});

describe("GET /api/dlq", () => {
  it("401 without a token", async () => {
    const res = await req("GET", "/api/dlq");
    expect(res.status).toBe(401);
  });

  it("403 for a dispatcher (dead_letter_queue is admin/auditor-only)", async () => {
    await bootstrapAdmin();
    await seedUser("disp", "dispatcher");
    const token = await login("disp", "Welcome2026!");
    const res = await req("GET", "/api/dlq", undefined, token);
    expect(res.status).toBe(403);
  });

  it("200 for administrator lists real DLQ entries once events fail 5 times", async () => {
    const token = await bootstrapAdmin();
    const unsub = eventBus.subscribe(
      "tasks.expired",
      () => {
        throw new Error("boom");
      },
      { consumerId: "http.dlq.feed" },
    );
    await eventBus.publishEnvelope({
      id: "evt-http-dlq",
      type: "tasks.expired",
      payload: { taskIds: [7], expiredAt: new Date().toISOString() },
      emittedAt: new Date().toISOString(),
      retryCount: 5,
    });

    const res = await req("GET", "/api/dlq", undefined, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; items: Array<{ eventPayload: { id: string } }> };
    expect(body.count).toBeGreaterThan(0);
    expect(body.items[0].eventPayload.id).toBe("evt-http-dlq");
    unsub();
  });

  it("filters by status=pending|replayed|archived when supplied", async () => {
    const token = await bootstrapAdmin();
    const res = await req("GET", "/api/dlq?status=pending", undefined, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ status: string }>; count: number };
    for (const row of body.items) {
      expect(row.status).toBe("pending");
    }
  });
});

describe("Unknown routes", () => {
  it("404 ROUTE_404 for an undeclared path", async () => {
    const res = await req("GET", "/api/nonexistent");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("ROUTE_404");
  });

  it("400 on malformed JSON body", async () => {
    const res = await fetch(`${server.url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not: valid",
    });
    expect(res.status).toBe(400);
  });
});
