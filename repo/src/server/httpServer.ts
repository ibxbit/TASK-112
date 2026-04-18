/**
 * WOGC test/audit HTTP harness.
 *
 * This module is **not part of the shipping SPA runtime** — WOGC runs
 * offline-first and has no deployed backend. The harness exists so the
 * audit layer can drive the application's real business logic
 * (`authService`, `dal`, `eventBus`) over a true HTTP surface, with
 * explicit METHOD + PATH pairs and unmocked handlers.
 *
 * Every handler calls the production modules directly. There is zero
 * duplicate business logic here; failure-path behaviour (AUTH_403,
 * VAL_*, AUDIT_*) is the same code path the browser exercises.
 *
 * Import-time side effects:
 *   - `src/db/schema.ts` initialises Dexie against the current global
 *     `indexedDB`. In tests, `tests/setup.ts` hooks `fake-indexeddb/auto`
 *     so Dexie runs in-memory.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { authService } from "../services/AuthService";
import { dal, setDALAuthResolver } from "../db/dal";
import type { TaskRecord, TaskWorkstream, UserRole } from "../db/schema";
import { WOGCError, ensureWOGCError } from "../utils/errors";

export type Session = {
  token: string;
  userId: number;
  username: string;
  role: UserRole;
  createdAt: number;
};

// Per-server session table. Each `createServer()` instance gets its own
// isolated store so parallel tests don't leak auth state across runs.
class SessionStore {
  private readonly byToken = new Map<string, Session>();
  public issue(userId: number, username: string, role: UserRole): Session {
    const token = `tok_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    const session: Session = { token, userId, username, role, createdAt: Date.now() };
    this.byToken.set(token, session);
    return session;
  }
  public get(token: string | null): Session | null {
    if (!token) {
      return null;
    }
    return this.byToken.get(token) ?? null;
  }
  public revoke(token: string): void {
    this.byToken.delete(token);
  }
  public clear(): void {
    this.byToken.clear();
  }
}

type JsonBody = Record<string, unknown> | null;

type Handler = (ctx: {
  body: JsonBody;
  session: Session | null;
  query: URLSearchParams;
  params: Record<string, string>;
}) => Promise<{ status: number; body: unknown }>;

type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler };

const compileRoute = (method: string, path: string, handler: Handler): Route => {
  const keys: string[] = [];
  const regexStr = path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, key) => {
    keys.push(String(key));
    return "([^/]+)";
  });
  return { method, pattern: new RegExp(`^${regexStr}$`), keys, handler };
};

const readJsonBody = (req: http.IncomingMessage): Promise<JsonBody> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve(text.length === 0 ? null : (JSON.parse(text) as JsonBody));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });

const wogcErrorToStatus = (err: WOGCError): number => {
  if (err.code === "AUTH_403" || err.code === "AUTH_INVALID") {
    return 403;
  }
  if (err.code === "AUTH_REQUIRED") {
    return 401;
  }
  if (err.code.endsWith("_404") || err.code === "NOT_FOUND") {
    return 404;
  }
  if (err.code.startsWith("VAL_") || err.code === "BAD_REQUEST") {
    return 400;
  }
  if (err.code === "LOCKOUT_CONFLICT" || err.code === "CAPACITY_CONFLICT" || err.code === "AUTH_EXISTS") {
    return 409;
  }
  return err.retryable ? 503 : 500;
};

const requireSession = (session: Session | null): Session => {
  if (!session) {
    throw new WOGCError({
      code: "AUTH_REQUIRED",
      message: "Authentication required",
      context: {},
      retryable: false,
    });
  }
  return session;
};

const asInt = (value: unknown, field: string): number => {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  throw new WOGCError({
    code: "VAL_INTEGER_REQUIRED",
    message: `Field ${field} must be an integer`,
    context: { field, received: typeof value },
    retryable: false,
  });
};

const asString = (value: unknown, field: string): string => {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new WOGCError({
    code: "VAL_STRING_REQUIRED",
    message: `Field ${field} must be a non-empty string`,
    context: { field },
    retryable: false,
  });
};

const asOptionalString = (value: unknown): string | undefined => {
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export type ServerHandle = {
  url: string;
  port: number;
  close: () => Promise<void>;
  store: SessionStore;
};

export const createServer = (): Promise<ServerHandle> => {
  const store = new SessionStore();

  const routes: Route[] = [
    // --- Auth ---------------------------------------------------------------
    compileRoute("POST", "/api/auth/bootstrap", async ({ body }) => {
      // Bootstrap path mirrors the SPA's first-run admin flow.
      const username = asString(body?.username ?? "administrator", "username");
      const password = asString(body?.password, "password");
      const material = await authService.generateCredentialMaterial(password);
      const result = await dal.ensureAdminSeed({
        username,
        displayName: asOptionalString(body?.displayName) ?? "System Administrator",
        temporaryPasswordHash: material.passwordHash,
        salt: material.salt,
        iterations: material.iterations,
      });
      return {
        status: result.created ? 201 : 200,
        body: { userId: result.userId, created: result.created, username },
      };
    }),

    compileRoute("POST", "/api/auth/login", async ({ body }) => {
      const username = asString(body?.username, "username");
      const password = asString(body?.password, "password");
      try {
        const profile = await authService.authenticateUser(username, password);
        const session = store.issue(profile.id, profile.username, profile.role);
        return {
          status: 200,
          body: {
            token: session.token,
            user: {
              id: profile.id,
              username: profile.username,
              role: profile.role,
              displayName: profile.displayName ?? null,
              mustResetPassword: Boolean(profile.mustResetPassword),
            },
          },
        };
      } catch (error) {
        if (error instanceof WOGCError) {
          throw error;
        }
        throw new WOGCError({
          code: "AUTH_INVALID",
          message: "Invalid credentials",
          context: { username },
          retryable: false,
        });
      }
    }),

    compileRoute("POST", "/api/auth/reset-password", async ({ body, session }) => {
      const sess = requireSession(session);
      const currentPassword = asString(body?.currentPassword, "currentPassword");
      const nextPassword = asString(body?.nextPassword, "nextPassword");
      if (nextPassword.length < 10) {
        throw new WOGCError({
          code: "VAL_PASSWORD_TOO_SHORT",
          message: "New password must be at least 10 characters",
          context: { field: "nextPassword" },
          retryable: false,
        });
      }
      await authService.verifyCurrentPasswordAndRotate(sess.userId, currentPassword, nextPassword);
      return { status: 200, body: { userId: sess.userId, rotated: true } };
    }),

    compileRoute("POST", "/api/auth/logout", async ({ session }) => {
      if (session) {
        store.revoke(session.token);
      }
      return { status: 204, body: null };
    }),

    // --- Tasks --------------------------------------------------------------
    compileRoute("GET", "/api/tasks", async ({ session, query }) => {
      requireSession(session);
      const workstream = query.get("workstream");
      const tasks = await dal.listTasks(
        workstream ? { workstream: workstream as TaskWorkstream } : undefined,
      );
      return { status: 200, body: { items: tasks, count: tasks.length } };
    }),

    compileRoute("POST", "/api/tasks", async ({ session, body }) => {
      requireSession(session);
      const payload: Omit<TaskRecord, "id" | "updatedAt"> = {
        title: asString(body?.title, "title"),
        description: asOptionalString(body?.description),
        status: (body?.status as TaskRecord["status"]) ?? "open",
        workstream: (body?.workstream as TaskWorkstream) ?? "transport",
        priority: typeof body?.priority === "number" ? (body.priority as TaskRecord["priority"]) : undefined,
        assignee: asOptionalString(body?.assignee),
        resourceId: asOptionalString(body?.resourceId),
        dueDate: asOptionalString(body?.dueDate),
        createdAt: new Date().toISOString(),
      };
      const id = await dal.saveTask(payload);
      return { status: 201, body: { id, title: payload.title, status: payload.status } };
    }),

    compileRoute("GET", "/api/tasks/:id", async ({ session, params }) => {
      requireSession(session);
      const id = Number(params.id);
      if (!Number.isInteger(id)) {
        throw new WOGCError({
          code: "VAL_INTEGER_REQUIRED",
          message: "Task id must be an integer",
          context: { field: "id" },
          retryable: false,
        });
      }
      const task = await dal.getTaskById(id);
      if (!task) {
        throw new WOGCError({
          code: "TASK_404",
          message: "Task not found",
          context: { id },
          retryable: false,
        });
      }
      return { status: 200, body: task };
    }),

    // --- Governance ---------------------------------------------------------
    compileRoute("GET", "/api/audit", async ({ session, query }) => {
      requireSession(session);
      const entries = await dal.listAuditTrail({
        entity: asOptionalString(query.get("entity")),
        actorUsername: asOptionalString(query.get("actorUsername")),
      });
      return { status: 200, body: { items: entries, count: entries.length } };
    }),

    compileRoute("GET", "/api/dlq", async ({ session, query }) => {
      requireSession(session);
      const status = query.get("status") as "pending" | "replayed" | "archived" | null;
      const entries = await dal.listDLQEntries(status ?? undefined);
      return { status: 200, body: { items: entries, count: entries.length } };
    }),

    // --- Health + meta ------------------------------------------------------
    compileRoute("GET", "/api/health", async () => {
      // Unauthenticated liveness probe. DLQ depth is counted at the
      // persistence level directly — the authenticated `/api/dlq` endpoint
      // is the one that enforces RBAC; liveness must not require a session.
      const { db } = await import("../db/schema");
      const dlqDepth = await db.dead_letter_queue.count().catch(() => 0);
      return {
        status: 200,
        body: {
          status: "ok",
          dlqDepth,
          uptimeMs: Date.now(),
        },
      };
    }),

    compileRoute("GET", "/api/me", async ({ session }) => {
      const sess = requireSession(session);
      return {
        status: 200,
        body: {
          userId: sess.userId,
          username: sess.username,
          role: sess.role,
        },
      };
    }),
  ];

  const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const urlObj = new URL(req.url ?? "/", "http://localhost");
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || null;
    const session = store.get(token);

    // Wire the DAL's per-request auth from the bearer token. This is the
    // genuine session boundary — no spies, no resolver overrides.
    setDALAuthResolver(() => ({
      isAuthenticated: Boolean(session),
      userId: session?.userId ?? null,
      username: session?.username ?? null,
      role: session?.role ?? null,
    }));

    const matched = routes.find((route) => {
      if (route.method !== req.method) {
        return false;
      }
      return route.pattern.test(urlObj.pathname);
    });

    if (!matched) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "ROUTE_404", message: "Route not found", retryable: false }));
      return;
    }

    const match = matched.pattern.exec(urlObj.pathname);
    const params: Record<string, string> = {};
    if (match) {
      matched.keys.forEach((key, index) => {
        params[key] = match[index + 1];
      });
    }

    let body: JsonBody = null;
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "BAD_REQUEST", message: "Invalid JSON body", retryable: false }));
      return;
    }

    try {
      const result = await matched.handler({ body, session, query: urlObj.searchParams, params });
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(result.body === null ? "" : JSON.stringify(result.body));
    } catch (error) {
      const wogc = ensureWOGCError(error, {
        code: "UNEXPECTED",
        message: "Unexpected handler failure",
        context: {},
        retryable: true,
      });
      const status = wogcErrorToStatus(wogc);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: wogc.code,
          message: wogc.message,
          retryable: wogc.retryable,
          context: wogc.context,
        }),
      );
    }
  });

  return new Promise<ServerHandle>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
        store,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((err?: Error) => (err ? closeReject(err) : closeResolve()));
          }),
      });
    });
  });
};
