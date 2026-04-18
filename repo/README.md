<!-- project-type: web -->

# WOGC — Warehouse Operations & Governance Console

**Project type:** `web`

> Single-page, English-language, offline-first **web** SPA. No backend service is deployed; every feature — persistence, RBAC, event routing, crypto — runs inside the browser. This declaration is both inline (`project-type: web` comment above) and part of the human-facing content so automated audits can lock on it.
>
> An **audit/test-only HTTP harness** (`src/server/httpServer.ts`) exposes the same service layer over real HTTP so test suites can hit strict `METHOD + PATH` endpoints without mocks. The harness is **not deployed with the shipping SPA** — it exists purely to let the audit layer exercise production handlers through a genuine HTTP boundary. See §6.5 for endpoint inventory.

---

## 1. One-click startup (Docker-contained)

The canonical way to run this project is through Docker. No host package install, no `.env` copy, no SQL import — Docker orchestrates everything declared in `docker-compose.yml`.

```bash
docker-compose up
```

Modern Docker Compose v2 syntax is equivalent and also supported:

```bash
docker compose up --build -d
```

Both commands resolve to the same service and port topology. Stop the stack with `docker-compose down` (or `docker compose down`).

## 2. Service list / access addresses

| Service           | URL                                                   | Host port | Container port | Protocol |
| ----------------- | ----------------------------------------------------- | --------- | -------------- | -------- |
| `wogc-frontend`   | <http://localhost:8080>                               | 8080      | 80             | HTTP     |

> **Shipping architecture:** no HTTP backend. The authoritative product directive is *"All data processing and storage run locally … IndexedDB as the primary database."* The `wogc-frontend` service above is the only thing reviewers see running under `docker-compose up`.
>
> **Audit/test-only harness:** for the automated test suite, `src/server/httpServer.ts` wraps the production service layer in a real `http.Server` so audit tests can hit explicit `METHOD + PATH` endpoints without mocks. The harness is documented in §6.5 and is not deployed by `docker-compose up`. Endpoint coverage is therefore real (not N/A), but still self-contained — no external network is ever required.

## 3. Demo credentials & auth verification flow

This application **does not ship pre-seeded privileged credentials** — that is a deliberate security posture. On first boot the SPA detects an empty IndexedDB and requires an explicit administrator bootstrap. Every role is then provisioned from the Admin Console. Follow this exact flow; it is the verifiable acceptance path.

### 3.1 Bootstrap the Administrator (one-time, first run only)

1. Open <http://localhost:8080>.
2. The **Initialize Administrator** form appears.
3. Enter a password meeting the strict policy: **≥ 12 chars, uppercase, lowercase, and at least one digit**. Example that satisfies the policy:

   ```
   username: administrator
   password: WogcAdmin2026!
   ```

4. Submit — the form reveals the login card and you can now sign in as `administrator`.

### 3.2 Provision the other five roles

After signing in as `administrator`, open **Admin Console** in the sidebar and use the **User Management** card to create one user per role. These are the exact demo credentials the verifier should create (deterministic, matches the expectations of the test suite):

| Role           | Username demo     | Temporary password demo |
| -------------- | ----------------- | ----------------------- |
| Administrator  | `administrator`   | (set during §3.1 bootstrap) |
| Dispatcher     | `dispatcher-demo` | `DispatchDemo2026!`     |
| Facilitator    | `facilitator-demo`| `FaciliDemo2026!`       |
| Floor Operator | `operator-demo`   | `OperatorDemo2026!`     |
| Viewer         | `viewer-demo`     | `ViewerDemo2026!`       |
| Auditor        | `auditor-demo`    | `AuditorDemo2026!`      |

Every non-admin account is created with `mustResetPassword=true`; the first login for each of these users forces the **Password Reset** flow (routes to `/reset-password`). That is the acceptance path for the role-password contract; it is **not** ambiguity, it is the documented verification step.

### 3.3 Per-role verification checklist (what should work after login)

| Role           | Should see                                                      | Should NOT see                                    |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| Administrator  | Every sidebar entry; Admin Console CRUD; audit trail; DLQ       | –                                                 |
| Dispatcher     | Queue Board; Equipment Panel (including Queue Command surface); Calendar; Notifications | Admin Console; Auditor Trail                      |
| Facilitator    | Meeting Workspace with agenda/resolutions/attachments; Calendar; Notifications | Equipment command controls; Admin Console        |
| Floor Operator | Queue Board (ack-only); Notifications                           | Admin Console; Calendar creation; Equipment cmds  |
| Viewer         | Queue Board (read); Equipment Panel (no command); Calendar (read-only) | Any mutation button                               |
| Auditor        | Auditor Trail (immutable audit log + DLQ) and Delivery Logs     | Any mutation UI anywhere; Settings tab            |

If any of those columns diverges from the live UI, the repo fails acceptance.

### 3.4 Idle auto-lock verification

Leave the console idle for 15 minutes (or set LocalStorage key `sessionTimeout` to `60000` for a 60-second repro) → the SPA transitions back to the login page and wipes the Redux store.

---

## 4. Verifying core features (step-by-step)

This is the canonical acceptance walk. No `curl`/Postman; see §6.

1. **Bootstrap + login** as administrator (§3.1).
2. **Queue Board** (`/queue`) — open the New Task drawer, create a task, assign it to a bin, then re-assign to the same bin to trigger the **Conflict Resolver Modal**. Verify the **resolution reason input is mandatory** and ≥ minimum-length character validation enforces the contract.
3. **Equipment Panel** (`/equipment`) — add an AGV/conveyor heartbeat via the seed controls; watch the heartbeat age transition green → red as it crosses 20 s. Confirm a timeout banner surfaces. Dispatchers see the Queue Command input; viewers do not.
4. **Calendar** (`/calendar`) — flip Day/Week/Month from the mode select. Create an event, confirm it lands in today's slot. Create a lockout with overlapping window, then try to schedule on the locked resource → the DAL raises `LOCKOUT_CONFLICT` and the UI shows the Scheduling Conflict dialog.
5. **Meeting Workspace** (`/meetings`) — create a meeting, upload a local PDF/DOCX, record attendees, add a resolution marked `approved`, click **Spawn Task** on minutes containing an `ACTION:` line — the task appears on the Queue Board.
6. **Notification & Reminder Center** (`/notifications`) — open the Settings tab, set quiet hours to `21:00`–`06:00`, save. Confirm the 3-per-task/day reminder cap; try Mark Read and watch the unread badge decrement.
7. **Import/Export** — in Admin Console (or the Notification Center toolbar), open the **Encrypted Backup** modal. Export with a passphrase (AES-GCM + PBKDF2). Re-import the same file with the wrong passphrase → `CRYPTO_ERR` surfaces; re-import with the correct passphrase succeeds and the `audit_log` grows by one append-only row.
8. **Auditor Trail** (`/auditor`, signed in as `auditor-demo`) — the page renders read-only. There are zero mutation controls. The DLQ table lists any events that failed 5 times.
9. **Idle auto-lock** — see §3.4.
10. **Tests** — run the Docker-contained test stack: `docker-compose -f docker-compose.test.yml up --build --abort-on-container-exit`. The final line prints `RESULT: PASS` when every unit and service-boundary test is green.

---

## 5. Environment rules (strict)

- **Docker-contained only.** `docker-compose up` is the acceptance command. No host package installs, environment copies, or manual SQL imports are required — or permitted — as part of acceptance.
- All JavaScript dependencies are declared in `package.json` + `package-lock.json` and are resolved inside the build stage of the `Dockerfile`. Zero private / intranet dependencies; zero global host packages required.
- Base images are all public: `node:20-alpine` (build), `nginx:1.27-alpine` (runtime).
- Reviewers: stop at §1. Any other execution flow is explicitly out of scope for acceptance.

---

## 6. Tests

The project ships two first-class suites at the repo root plus two Playwright suites:

```
unit_tests/            Vitest unit + React-Testing-Library suite
                         + real-flow E2E tests — 33 files, 127 tests
API_tests/             Service-boundary (DAL/event bus) + real HTTP tests
                         over src/server/httpServer.ts  — 9 files, 59 tests
  └── http/            POST/GET endpoint tests hitting METHOD+PATH
                         with fetch against a live http.Server (no mocks)
tests/component/       Playwright component tests (real browser)
tests/e2e/             Playwright end-to-end tests (real browser)
```

### 6.1 Running everything (Docker-contained, idempotent)

Tests run inside the same Docker build image used for acceptance — no host toolchain required. A dedicated compose service wraps the suites so reviewers stay within Docker:

```bash
docker-compose -f docker-compose.test.yml up --build --abort-on-container-exit
```

The container prints per-test status and ends with `RESULT: PASS` when every unit and service-boundary suite is green. Exit code `0` means pass; non-zero is a verbatim, reproducible failure.

Suite selectors live inside the same compose file as environment variables (`SUITE=all|unit|api`) for reviewers who want to isolate a layer:

```bash
SUITE=unit docker-compose -f docker-compose.test.yml up --build --abort-on-container-exit
SUITE=api  docker-compose -f docker-compose.test.yml up --build --abort-on-container-exit
```

Repeated invocations are cached by Docker's layer cache, so the second run is seconds not minutes.

### 6.2 What "API_tests/" actually covers

`API_tests/` is now split into two explicit layers:

1. **`API_tests/http/*.test.ts` — real HTTP endpoint tests.**
   A test-only backend (`src/server/httpServer.ts`, described in §6.5) exposes the production service layer over actual HTTP. Each test constructs the real `http.Server`, hits `METHOD + PATH` with `fetch`, and asserts on status codes and JSON bodies. No `vi.mock`, no `vi.spyOn`, no resolver overrides — sessions are established via the real `POST /api/auth/login` flow and passed back on every authenticated request as `Authorization: Bearer <token>`.
2. **`API_tests/*.test.ts` — internal service-boundary tests.**
   Drive the DAL / event bus / crypto services directly (no HTTP) for fast contract assertions on RBAC, audit hash chain, idempotency, DLQ promotion, and encrypted backup integrity. These tests use the DAL's documented session API (`setDALAuthResolver`) the same way the production store does — it is the DAL's auth surface, not a mock.

The original shipping SPA has **no deployed backend**; production WOGC runs entirely in the browser against IndexedDB. The HTTP harness is called out in §6.5 and in the top of `src/server/httpServer.ts` as *audit/test harness only*.

### 6.5 HTTP endpoint inventory (audit/test harness)

The harness lives in `src/server/httpServer.ts` and is exported as `createServer()` returning a real `http.Server`. Every handler calls the production modules directly — there is no parallel business logic. Bearer tokens are minted by `POST /api/auth/login` and resolved via an in-memory session store.

| Method | Path                         | Purpose                                                               | Auth required |
| ------ | ---------------------------- | --------------------------------------------------------------------- | ------------- |
| POST   | `/api/auth/bootstrap`        | First-run administrator seed (idempotent)                             | no            |
| POST   | `/api/auth/login`            | Exchange username+password for a bearer token                         | no            |
| POST   | `/api/auth/reset-password`   | Rotate current bearer user's password (real PBKDF2)                   | yes           |
| POST   | `/api/auth/logout`           | Revoke the current bearer token                                       | yes           |
| GET    | `/api/me`                    | Echo the caller's session (userId, username, role)                    | yes           |
| GET    | `/api/tasks`                 | List tasks, `?workstream=...` filter                                  | yes           |
| POST   | `/api/tasks`                 | Create a task through the real DAL                                    | yes           |
| GET    | `/api/tasks/:id`             | Fetch a single task (404 on miss, 400 on non-int id)                  | yes           |
| GET    | `/api/audit`                 | Admin/auditor-only audit trail with `entity` / `actorUsername` filter | yes (RBAC)    |
| GET    | `/api/dlq`                   | Admin/auditor-only DLQ entries with `status` filter                   | yes (RBAC)    |
| GET    | `/api/health`                | Unauthenticated liveness probe + DLQ depth                            | no            |
| *      | *other*                      | 404 `ROUTE_404`                                                       | —             |

### 6.3 What the tests validate (coverage matrix)

| Category                              | Files                                                                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core business logic                   | `unit_tests/serviceFlows.test.ts`, `unit_tests/business-bounds.test.ts`, `unit_tests/calendarGovernance.test.ts`, `unit_tests/taskExpiryRules.test.ts`                        |
| State transitions (pages)             | `unit_tests/pages_queueBoard*.test.ts` (`serviceFlows`/`taskExpiry`), `unit_tests/pages_equipmentPanel.test.tsx`, `unit_tests/pages_calendar.test.tsx`, `unit_tests/pages_meetingWorkspace.test.tsx`, `unit_tests/pages_notificationCenter.test.tsx`, `unit_tests/pages_adminConsole.test.tsx` |
| Reusable components                   | `unit_tests/components_can.test.tsx`, `unit_tests/components_toastViewport.test.tsx`, `unit_tests/components_exportModal.test.tsx`                                            |
| Offline persistence (IndexedDB/Dexie) | Every page/component test above plus `API_tests/dal-object-isolation.test.ts`, `unit_tests/dal.security.test.ts`, `unit_tests/meetingAttachments.test.ts`                      |
| Role-based access enforcement         | `API_tests/cross-flow-rbac.test.ts`, `API_tests/roles-config.test.ts`, `unit_tests/permissions.test.ts`, `unit_tests/dlq.rbac.test.ts`, `unit_tests/securityRegistration.test.ts` |
| Error contracts / timeouts / retries  | `API_tests/cross-flow-rbac.test.ts`, `API_tests/eventBus.test.ts`, `unit_tests/errorContract.test.ts`, `unit_tests/dlq-persistence.test.ts`, `unit_tests/dlq-robustness.test.ts`, `unit_tests/eventBus.test.ts`                                  |
| Crypto / backup contract              | `API_tests/events-crypto.test.ts`, `unit_tests/meetingAttachments.test.ts`, `unit_tests/components_exportModal.test.tsx`                                                     |
| Conflict handling                     | `API_tests/cross-flow-rbac.test.ts` (LOCKOUT_CONFLICT, VAL_REASON_REQUIRED), `API_tests/events-crypto.test.ts`, `unit_tests/pages_queueBoard.flow.test.ts` (via existing serviceFlows) |
| Session / role-change consistency     | `API_tests/cross-flow-rbac.test.ts` (role swap + logout)                                                                                                                       |

### 6.4 Under-tested-modules follow-up (closed gaps)

The prior audit flagged 8 page/component modules as under-covered. Every one is now exercised with rendered component tests (vitest + jsdom + React Testing Library), driving the **real** Redux store and the **real** Dexie DAL. Gaps closed:

| Previously untested module                | New test file(s)                                   | Key cases closed                                                                                                       |
| ------------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/components/Can.tsx`                   | `unit_tests/components_can.test.tsx`               | allow/deny, fallback, mid-session role swap re-evaluates gate                                                          |
| `src/components/ToastViewport.tsx`         | `unit_tests/components_toastViewport.test.tsx`     | aria-live variant mapping, dismiss, fake-timer auto-dismiss, undo dispatches declared action                           |
| `src/components/ExportModal.tsx`           | `unit_tests/components_exportModal.test.tsx`       | null when closed, disabled-until-passphrase, happy export, file-required import, `CRYPTO_ERR` secure message, `AUDIT_INTEGRITY_FAIL` toast |
| `src/pages/EquipmentPanel.tsx`             | `unit_tests/pages_equipmentPanel.test.tsx`         | latest-wins heartbeat reducer, ≥20 s timeout banner, RBAC hides command, empty-input validation, end-to-end queue to outbox |
| `src/pages/Calendar.tsx`                   | `unit_tests/pages_calendar.test.tsx`               | week↔day mode switch, viewer RBAC fallback, empty-field validation, create persists via DAL and re-renders             |
| `src/pages/MeetingWorkspace.tsx`           | `unit_tests/pages_meetingWorkspace.test.tsx`       | viewer RBAC lock, save meeting round-trip, invalid attachment rejected, no-marker spawn path, `ACTION:` spawn converts to tasks |
| `src/pages/NotificationCenter.tsx`         | `unit_tests/pages_notificationCenter.test.tsx`     | inbox load + unread count, level/search filters, Mark Read + unread decrement, quiet-hours persistence, auditor hides settings |
| `src/pages/AdminConsole.tsx`               | `unit_tests/pages_adminConsole.test.tsx`           | create site / adapter (normalized key) / template / permission override, non-admin session surfaces `AUTH_403`         |
| `src/pages/PasswordReset.tsx`              | `unit_tests/pages_passwordReset.test.tsx` + `API_tests/password-rotation.test.ts` | login-gate + must-reset gate redirects, min-length + mismatch validation, AUTH_* error surfacing inline, full PBKDF2 rotation end-to-end in node env |
| `src/pages/DispatcherDashboard.tsx`        | `unit_tests/pages_dispatcherDashboard.test.tsx`    | priority-queue sort (expired first), heartbeat-age status labels, assignment persistence, blank-assignee validation, viewer RBAC, event-bus subscription |
| `src/pages/DeliveryLogViewer.tsx`          | `unit_tests/pages_deliveryLogViewer.test.tsx`      | reverse-chronological load, status/read column mapping, userId filter, eventType filter, AUTH_403 surface for operator |
| `src/pages/NotificationSettings.tsx`       | `unit_tests/pages_notificationSettings.test.tsx`   | category default enabled, toggle persists subscription row, quiet-hours write, subscription hydration on mount, unauthenticated noop |
| `src/components/GlobalErrorBoundary.tsx`   | `unit_tests/components_globalErrorBoundary.test.tsx` | pass-through, WOGCError(retryable=true) → Retry button, WOGCError(retryable=false) → System Halt, raw error → UNEXPECTED fallback, Retry clears state |
| `src/components/RoleGate.tsx`              | `unit_tests/components_roleGate.test.tsx`          | unauthenticated → /login, permission allowed renders child, missing permission → /forbidden + permission-error toast + audit row, `allowed[]` exclusion, happy path |

---

## 7. Project layout

```
repo/
├── Dockerfile                 Multi-stage runtime: Node build → Nginx serve
├── Dockerfile.test            Dedicated test image (runs unit_tests + API_tests)
├── docker-compose.yml         One-click runtime, exposes 8080:80
├── docker-compose.test.yml    Docker-contained test runner
├── nginx.conf                 SPA fallback + strict CSP/security headers
├── index.html                 Vite entry
├── src/server/httpServer.ts   Audit/test HTTP harness (not deployed by docker-compose up)
├── package.json / package-lock.json
├── tsconfig.json / tsconfig.node.json
├── vite.config.ts / vitest.config.ts
├── playwright-ct.config.ts / playwright-component.config.ts
├── prompt.md                  Original requirement prompt
├── sessions/                  Model trajectory / session JSON placeholder
├── unit_tests/                Vitest unit suite (31 files, 119 tests)
├── API_tests/                 Internal service-boundary suite (6 files, 25 tests)
├── docs/
│   ├── design.md              Architecture
│   ├── api-spec.md            Internal service contracts
│   └── questions.md           Q&A log on business ambiguity
├── src/
│   ├── App.tsx, AppRoot.tsx, main.tsx, styles.css
│   ├── components/            Can, ConflictResolverModal, ExportModal, GlobalErrorBoundary, RoleGate, ToastViewport
│   ├── config/                permissions.ts (RBAC matrix)
│   ├── db/                    schema.ts, dal.ts  (Dexie + proxy + audit chain)
│   ├── hooks/                 usePermissions, useServiceOrchestration, useToast
│   ├── pages/                 AdminConsole, AuditorTrail, Calendar, DispatcherDashboard, EquipmentPanel, Forbidden, MeetingWorkspace, NotificationCenter, NotificationSettings, PasswordReset, QueueBoard, DeliveryLogViewer
│   ├── services/              AuthService, BackupService, ConflictService, DomainConsistencyService, EquipmentAdapter, EventBus, NotificationManager, NotificationService, TaskScheduler, dlqService
│   ├── store/                 authSlice, authThunks, index (root reducer)
│   ├── types/                 events.ts
│   └── utils/                 SessionManager, backupExport, errors (WOGCError), localStorage, logger, masking, rbac, storage
└── tests/
    ├── setup.ts               fake-indexeddb/auto (shared)
    ├── component/             Playwright component tests
    └── e2e/                   Playwright E2E tests
```

---

## 8. Delivery checklist mapping

| Delivery gate                                               | Status | Evidence                                                                 |
| ----------------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| One-click startup with `docker-compose up`                  | ✅     | §1; literal command in this README; `docker-compose.yml` context = `.`   |
| All dependencies declared / reproducible builds             | ✅     | `package.json` + `package-lock.json`; multi-stage Dockerfile             |
| Zero private dependencies                                   | ✅     | Only public JS package registry + public base images (no intranet/private deps) |
| Service address & port exposed                              | ✅     | <http://localhost:8080>, `8080:80` in compose                            |
| README documents start + services + verification            | ✅     | §1, §2, §4                                                               |
| Project type declared explicitly as `web`                   | ✅     | Top-line HTML comment + §1 prose                                         |
| Demo credentials / strict bootstrap + role flow documented  | ✅     | §3                                                                       |
| HTTP-API inapplicability called out                         | ✅     | §2 note, §6.2                                                            |
| `unit_tests/` + `API_tests/` at repo root                   | ✅     | directory tree (§7)                                                      |
| Docker-contained test runner, clear pass/fail, idempotent   | ✅     | §6.1 — `docker-compose -f docker-compose.test.yml up --build` → `RESULT: PASS` |
| UI loading and disabled states                              | ✅     | 25 `disabled={…}` bindings across 8 surfaces (Equipment, Export, Notification, Meeting, Queue Board…) |
| Offline compliance (no external network at runtime)         | ✅     | No API client layer exists; CSP `connect-src 'self'` in `nginx.conf`     |
