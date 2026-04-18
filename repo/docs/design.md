# SYSTEM ARCHITECTURAL DESIGN (REVISED)

## 1. Architectural Guarantees & Global Invariants

*   **Global Error Contract (The Boundary Enforcer):** All exceptions, rejections, and validations across the application MUST be normalized into a strict, globally available `WOGCError` object: `{ code: string, message: string, context: Record<string, any>, retryable: boolean }`. Raw JS errors are explicitly caught at the module boundary and converted.
*   **Enforceable DAL Security Boundary:** Direct IndexedDB access is structurally blocked. The Data Access Layer (DAL) is a singleton proxy. If the Redux Role state lacks permissions for a write/read, the DAL synchronously throws a `WOGCError` with `code: 'AUTH_403', retryable: false`, completely halting the execution chain before Dexie is invoked.
*   **Immutable Audit Trail:** Every DAL mutation appends to the `audit_log`. If the audit append fails, the parent transaction rolls back, and a `WOGCError` with `code: 'AUDIT_FAULT'` is thrown.
*   **Event Idempotency & Contract-Driven DLQ:** The Event Bus inspects the `retryable` flag of a `WOGCError`. If `retryable: false`, the event bypasses the 5-retry rule and goes immediately to the Dead Letter Queue (DLQ).
*   **Cryptographic Boundaries:** Stored passwords use PBKDF2-HMAC-SHA256 (120k iterations). Encrypted JSON backups use AES-GCM.
*   **Strict Ephemerality:** Redux state auto-wipes upon explicit logout, Role change, or the 15-minute idle timeout.

## 2. Core Subsystems

*   **Contract & Error Tier:** Centralized error classes, status mapping, and UI interceptors.
*   **IndexedDB (Data Tier):** dexie.js schema: `users`, `tasks`, `equipment_heartbeats`, `calendar_events`, `meetings`, `notifications`, `audit_log`, `message_outbox`.
*   **State Tier (Redux Toolkit):** Volatile state: `auth`, `ui`, `eventBus`. A global Redux middleware normalizes all rejected thunks into the `WOGCError` contract.
*   **Equipment Adapter Layer:** Simulates AGV/Conveyor latency via the `message_outbox` store. Translates heartbeat timeouts into `WOGCError` (`code: 'EQUIP_TIMEOUT', retryable: true`).
*   **UI/UX Boundary:** React SPA wrapped in an Auth Router and a Global Error Boundary. The Error Boundary specifically reads the `retryable` flag to render a conditional "Retry" action or a terminal "System Halt" state.

---

# 📝 IMPLEMENTATION PLAN (PROMPT BREAKDOWN)

## 🟦 1. FEATURE PROMPTS (Strictly Ordered)

### Prompt 1.1: Core App Shell, Error Contract & Strict DAL
```text
[Meta-Tags] Persona: Senior Engineer | Context: Feature Dev | Format: Code
[WOGC Foundation: Error Contracts, Auth & Local Storage]

Description & Goal: Build the React SPA shell, Redux store, Global Error Contract, and strict IndexedDB DAL.

Requirements:
Functionality: 
1. Define the Global Error Contract: `class WOGCError extends Error { code, message, context, retryable }`.
2. Setup React Router with a Global Error Boundary that reads `retryable` to conditionally render a Retry button. 
3. Implement 15-minute idle auto-lock (wipes Redux, redirects to login). Implement PBKDF2 local auth.
Database & Data-Level Security: Create Dexie schema. Create the DAL proxy module. The DAL MUST verify Redux auth state. If unauthorized, throw `WOGCError(code: 'AUTH_403', retryable: false)`. Every mutation must append to `audit_log`.
Explicit Contracts: All rejected Redux thunks must be normalized to `WOGCError`. No raw errors leak to the UI. LocalStorage holds only `theme`/`last_site`.

Expected Output: /src/utils/errors.ts, /src/store/authSlice.ts, /src/db/schema.ts, /src/db/dal.ts, /src/App.tsx, /src/components/GlobalErrorBoundary.tsx.
```

### Prompt 1.2: Event Bus, Schedulers & Equipment Adapter
```text
[Meta-Tags] Persona: Senior Engineer | Context: Feature Dev | Format: Code
[WOGC Operations Engine: Contract-Driven Pub-Sub & Adapters]

Description & Goal: Implement background processing and the simulated equipment adapter enforcing the new Error Contract.

Requirements:
Functionality: Create the in-app Pub-Sub Event Bus. Catch all consumer errors. If a consumer throws a `WOGCError` with `retryable: false`, move the event immediately to the DLQ. If `retryable: true`, enforce exponential backoff (max 5 retries). 
Equipment Adapter: Read `message_outbox`. Generate heartbeats. If no heartbeat for 20s, emit event. If equipment commands fail, throw `WOGCError(code: 'EQUIP_FAIL', retryable: true)`. 
Task Scheduler: Sweep IndexedDB `tasks` store every minute. Expire unacknowledged 30-min tasks.

Expected Output: /src/services/EventBus.ts, /src/services/TaskScheduler.ts, /src/services/EquipmentAdapter.ts, /src/types/events.ts.
```

### Prompt 1.3: Operations & Governance UI Components
```text
[Meta-Tags] Persona: Senior Engineer | Context: Feature Dev | Format: Code
[WOGC UI: Queue Board, Equipment Panel & Calendar]

Description & Goal: Build the dense operational React views.

Requirements:
Functionality & UI/UX:
1. Queue Board: Table + Drawer pattern. 
2. Conflict Resolver Modal: Highlight double-assigned resources. Force a resolution reason. If submission fails, parse the `WOGCError` to show inline validation feedback.
3. Equipment Panel: Color-coded heartbeat age (Green <5s, Yellow >10s, Red >20s). 
4. Calendar: Aggregates occupancy, holds, maintenance.
5. Meeting Workspace: Handle local file Blobs, sign-in, minutes, and task spawning.

Explicit Contracts: All components wrap DAL calls in try/catch blocks that explicitly type-check for `WOGCError`, mapping `code` to specific UI toast alerts or inline text.

Expected Output: /src/pages/QueueBoard.tsx, /src/components/ConflictModal.tsx, /src/pages/EquipmentPanel.tsx, /src/pages/Calendar.tsx, /src/pages/MeetingWorkspace.tsx.
```

### Prompt 1.4: Notification Center & Encrypted Import/Export
```text
[Meta-Tags] Persona: Senior Engineer | Context: Feature Dev | Format: Code
[WOGC Edge: Notifications & Encrypted Backup]

Description & Goal: Implement unified notifications and secure backup.

Requirements:
Functionality:
1. Notification Center: Subscribe to Event Bus. Enforce quiet hours (9PM-6AM). Cap reminders to 3/task/day. Filterable table view. 
2. Import/Export: Export Dexie DB to JSON Blob via FileSaver. Encrypt payload (AES-GCM) with passphrase. 

Explicit Contracts: If encryption/decryption fails, throw `WOGCError(code: 'CRYPTO_ERR', retryable: false, context: { file })`. UI must display the specific error context securely.

Expected Output: /src/pages/NotificationCenter.tsx, /src/services/BackupService.ts, /src/components/ExportModal.tsx.
```

## 🟧 2. DOCKERIZATION PROMPT
```text
[Meta-Tags] Persona: DevOps Engineer | Context: Containerization | Format: Docker configs
[Dockerizing WOGC Frontend]

Requirements:
Strictly wrap the client-side SPA in a container. No local host execution.
1. Multi-stage `Dockerfile`: Stage 1 (Node.js `npm run build`), Stage 2 (Nginx Alpine serving `/dist`).
2. `nginx.conf`: Route all unknown paths to `index.html`. Inject strict CSP headers.
3. `docker-compose.yml`: Map port 8080. Ensure `package-lock.json` is strictly adhered to.

Expected Output: Dockerfile, docker-compose.yml, nginx.conf. Provide exact build/run commands.
```

## 🟨 3. DOCUMENTATION PROMPT
```text
[Meta-Tags] Persona: Technical Writer | Context: Operations Documentation
[WOGC Project Documentation]

Requirements:
Generate a `README.md` tracking the system.
Must include:
- Architectural explanation of the IndexedDB DAL and the Global Error Contract (`WOGCError`).
- Explicit absolute URL for the Web UI (e.g., http://localhost:8080).
- Default Admin credentials.
- Instructions on parsing DLQ JSON exports and identifying `retryable: false` fault codes.

Expected Output: README.md file.
```

## 🟩 4. TESTING PROMPTS

### Prompt 4.1: Unit Testing (Contracts, Crypto & Event Bus)
```text
[Meta-Tags] Persona: Senior QA & Security SDET | Context: Unit Testing | Format: Code
[Unit Testing: Error Contracts & Event Bus]

Adversarial Threat Analysis: Does the Event Bus properly isolate failures? What happens if a raw JS Error bypasses the WOGCError contract?

Risk-Driven Test Coverage:
- Happy Path: Event published, processed, WOGCError(retryable: true) triggers backoff.
- Adversarial/Failure Paths: Consumer throws `WOGCError(retryable: false)` -> verify immediate DLQ insertion. Throw raw `TypeError` -> verify Event Bus catches, normalizes to WOGCError, and handles safely.

Execution Rules: Jest/Vitest inside Docker.

Expected Output: /tests/unit/errorContract.test.ts, /tests/unit/eventBus.test.ts. Docker command.
```

### Prompt 4.2: Integration Testing (DAL & Error Boundaries)
```text
[Meta-Tags] Persona: Senior QA & Security SDET | Context: Integration Testing | Format: Code
[Integration Testing: DAL Security Boundaries]

Adversarial Threat Analysis: Can unauthorized Redux state perform a write? Does the DAL leak internal Dexie exceptions instead of the contract?

Risk-Driven Test Coverage:
- Happy Path: Admin role writes task -> Audit log appends.
- Adversarial/Failure Paths: Force a Dexie schema error -> verify DAL catches and throws `WOGCError(code: 'DB_FAULT')`. Floor Operator tries writing Admin config -> verify DAL throws `WOGCError(code: 'AUTH_403', retryable: false)` and Dexie write is blocked.

Execution Rules: `fake-indexeddb` inside Docker.

Expected Output: /tests/integration/dal.test.ts. Docker command.
```

### Prompt 4.3: End-to-End Component Testing (UI Error Parsing)
```text
[Meta-Tags] Persona: Senior QA & Security SDET | Context: E2E Component Testing | Format: Code
[Component/E2E Testing: Global Error Boundaries]

Adversarial Threat Analysis: Do terminal errors crash the React tree? Do users see raw stack traces?

Risk-Driven Test Coverage:
- Happy Path: Standard queue resolution workflow.
- Adversarial/Failure Paths: Mock the DAL to throw `WOGCError(retryable: true)` on task submission -> verify UI renders the "Retry" button. Mock DAL to throw `WOGCError(retryable: false)` -> verify UI hides Retry button and shows Terminal Halt state. Fast-forward timer 15 mins -> verify auto-lock.

Execution Rules: Cypress/Playwright Component Testing via Docker.

Expected Output: /tests/e2e/error-boundary.spec.ts, /tests/e2e/auth-flow.spec.ts. Docker command.
```
