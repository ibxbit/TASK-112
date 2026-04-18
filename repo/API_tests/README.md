# `API_tests/` — internal service-boundary and HTTP coverage

WOGC is an offline SPA. Its "API" surface is twofold:

1. **HTTP audit harness** (`API_tests/http/*.test.ts`)
   - Drives the real `src/server/httpServer.ts` (a test-only backend that
     exposes production services over HTTP). Every request is made with
     `fetch` against a real `http.Server` listening on `127.0.0.1:<port>`.
   - **No mocks, no resolver overrides.** Sessions are established via the
     genuine `POST /api/auth/login` flow — the harness reads the
     `Authorization: Bearer <token>` header and wires the DAL session
     exactly as a production backend would.
   - Endpoint inventory and test mapping live in the main `README.md`.

2. **Internal service-boundary tests** (`API_tests/*.test.ts`)
   - Drive the DAL + event bus + services directly, in-process, without
     the HTTP layer. They use `setDALAuthResolver(() => snapshot)` to
     pin the acting user for each assertion.
   - `setDALAuthResolver` is **the production API the SPA itself calls**
     (see `src/store/index.ts`); it is not a mock and not a workaround.
     It is simply the DAL's session surface, invoked from a different
     caller. No handler/service logic is stubbed out.
   - These tests exist so each contract (RBAC, audit hash chain, DLQ,
     event-bus idempotency, crypto rotation) can be asserted in isolation
     without the HTTP handshake overhead.

## Mock policy

The harness, HTTP tests, and the real app runtime use **zero `vi.mock`,
`vi.spyOn`, or stubbed services** for the business logic under test.

A small number of legacy tests in `unit_tests/` still use narrowly-scoped
`vi.spyOn` calls — each one either (a) forces a specific failure path that
cannot be reproduced through real inputs (e.g., `QuotaExceededError`,
`CRYPTO_ERR`), or (b) silences React's intentional error-boundary stderr.
The reason is documented in the test file's top comment. None of them
replace production modules under test.
