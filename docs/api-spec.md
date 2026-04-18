# WOGC Internal API Specification

Because the Warehouse Operations & Governance Console (WOGC) operates as a strictly offline-first, client-side SPA, there are no traditional HTTP backend APIs (REST or GraphQL). 

Instead, the "API" refers to the highly structured internal service boundaries that ensure data integrity, role-based access control (RBAC), and asynchronous service orchestration within the browser.

---

## 1. Global Error Contract (`WOGCError`)

All exceptions, rejections, and validations across the application must cross boundaries as a normalized `WOGCError` object. Raw JavaScript errors (`TypeError`, `DOMException`) are explicitly caught and converted.

### `WOGCErrorInput` Interface
```typescript
{
  code: string;       // Unique string identifier (e.g., 'AUTH_403', 'EQUIP_FAIL')
  message: string;    // Human-readable fallback message
  context?: object;   // Key-value pairs of relevant debugging metadata
  retryable: boolean; // Determines if the UI/EventBus should attempt a retry or halt
}
```

### Key Error Codes
| Code | Meaning | Retryable |
| :--- | :--- | :--- |
| `AUTH_403` | User lacks sufficient Redux Role permissions for the DAL operation | `false` |
| `AUDIT_FAULT` | The cryptographic hash chain append failed | `false` |
| `EQUIP_FAIL` | Simulated hardware command execution failed | `true` |
| `EQUIP_TIMEOUT` | No heartbeat received from equipment within 20s | `true` |

---

## 2. Event Bus (Pub/Sub) API

The `EventBus` provides decoupled communication between UI actions and background workers (Task Scheduler, Equipment Adapter). Events are guaranteed to be **idempotent**, utilizing an IndexedDB-backed registry to prevent duplicate execution during replays.

### Event Envelope Structure
```typescript
{
  id: string;               // UUID (v4)
  type: WOGCEventType;      // The routing topic
  payload: object;          // Strongly typed payload based on event type
  emittedAt: string;        // ISO 8601 Timestamp
  retryCount: number;       // Tracks exponential backoff
}
```

### Standard Event Topics & Payloads

#### `equipment.command.requested`
Fired when the Equipment Panel pushes an outbox command.
- **Payload**: `{ outboxId, equipmentId, command, args }`

#### `equipment.heartbeat.generated`
Fired continuously (every 5s) by the simulated `EquipmentAdapter`.
- **Payload**: `{ equipmentId, latencyMs, observedAt }`

#### `equipment.heartbeat.timeout`
Fired if the `EquipmentAdapter` does not register a heartbeat for > 20s.
- **Payload**: `{ equipmentId, lastHeartbeatAt, timeoutMs }`

#### `tasks.expired`
Fired by the `TaskScheduler` sweep if a task remains unacknowledged for > 30 minutes.
- **Payload**: `{ taskIds: number[], expiredAt }`

#### `meeting.resolution.approved`
Fired when an agenda item is successfully resolved and signed off.
- **Payload**: `{ resolutionId, meetingId, approvedAt }`

---

## 3. Data Access Layer (DAL) Methods

The `dal` operates as a Singleton Proxy sitting over IndexedDB (Dexie). You cannot mutate the database natively; you must use these internal API methods, which synchronously enforce RBAC masking and append to the SHA-256 hash-chained `audit_log`.

### Operational API
- **`saveTask(taskDraft)`**: Validates conflict resolution against active Calendar holds. Appends audit log. Resolves the ID.
- **`recordHeartbeat(payload)`**: Mutates the `equipment_heartbeats` table directly.
- **`expireTasks(taskIds)`**: Bulk updates task statuses to `expired`.
- **`deleteOutboxMessage(outboxId)`**: Removes a command after equipment acknowledgment.

### Governance API
- **`listAuditTrail(filters)`**: Generates a descending query of the immutable hash chain. Restricted to the `auditor` role.
- **`listDLQEntries()`**: Returns the contents of the Dead Letter Queue.
- **`updateDLQStatus(id, status)`**: Transitions DLQ events locally to either `replayed` or `archived`.

### Security API
- **`registerLocalUser(payload)`**: Applies PBKDF2 with 120,000 iterations against the submitted password and a local 16-byte salt.
- **`importRuntimeConfig(jsonString)`**: Applies emergency overrides to system thresholds affecting sweeps, expiries, and permissions.
