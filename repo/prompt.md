# Original Prompt — Warehouse Operations & Governance Console (WOGC)

> This file is the verbatim product requirement used to construct this repository. It is preserved for delivery traceability. Do not edit unless the upstream prompt is revised.

## Requirement

Construct a **Warehouse Operations & Governance Console (WOGC)** supporting offline warehouse execution and internal governance workflows in a single-page, English-language web experience. Users include Administrator (configures sites, equipment adapters, templates, and permissions), Warehouse Dispatcher (manages putaway/transport/picking/replenishment queues), Floor Operator (acknowledges tasks and exceptions), Meeting Facilitator (runs agenda and minutes), and Auditor (read-only access to immutable trails). The React SPA uses responsive routing and dense operational screens: a Queue Board with Table + Drawer patterns to triage work, a Conflict Resolver Modal that highlights double-assigned bins/equipment and forces a resolution reason, an Equipment Panel showing AGV/conveyor status with color-coded heartbeat age, a Calendar page (day/week/month) aggregating occupancy, temporary holds, maintenance lockouts, and capacity, and a Meeting Workspace to collect agenda items, distribute locally uploaded materials (PDF/DOCX), run attendance sign-in, capture minutes/resolutions, and break resolutions into executable tasks with due dates. A unified Notification & Reminder Center lets users subscribe to event types and choose in-app delivery only (no SMS/email/push), set quiet hours (e.g., 9:00 PM–6:00 AM), and cap reminders to 3 per task per day; notifications display read receipts and a delivery log in a Table with filters by user, event, and time range.

All data processing and storage run locally: the application uses React with client-side state management (e.g., Redux Toolkit) and persistence via IndexedDB as the primary "database," with LocalStorage reserved for lightweight settings such as theme, last site, and session timeout. Authentication is local username + password only; passwords are salted and hashed in-browser (PBKDF2, 120,000 iterations), sessions auto-lock after 15 minutes idle, and sensitive fields (names, badge IDs) are masked in UI unless the role allows full view. Business logic is implemented in a frontend Service layer operating on IndexedDB records and locally imported JSON configuration. Task scheduling enforces deterministic rules: each work item has a priority (1–5), expires after 30 minutes if unacknowledged, retries equipment commands up to 3 times with 10-second backoff, and raises a timeout alert if no heartbeat is received for 20 seconds. Equipment integration is handled through an adapter layer that simulates AGV/conveyor callbacks by reading/writing to a local "message outbox" store; a pub-sub event bus inside the app provides idempotent consumers, retry with exponential backoff, and a dead-letter list for events failing 5 times, ensuring eventual consistency across queues, calendar holds, meeting tasks, and notifications. Import/export is supported through user-initiated file selection and Blob-based downloads (FileSaver-style), producing encrypted JSON backups with a user-provided passphrase and audit-stamped, append-only change records for compliance review.

## Technology Stack

| Dimension          | Value              |
| ------------------ | ------------------ |
| Project type       | `pure_frontend`    |
| Frontend language  | TypeScript         |
| Frontend framework | React 18           |
| Backend            | None (client-only) |
| Database           | IndexedDB (Dexie)  |

> Note: the top-level prompt mentions Node.js + PostgreSQL as a suggested stack, but the **primary directive — "all data processing and storage run locally … IndexedDB as the primary database"** — mandates an offline-first SPA. No backend service is deployed.
