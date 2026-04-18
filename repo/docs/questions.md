# Architectural & Logical Questions 

This document captures the most significant ambiguities identified in the WOGC requirements, organized by priority and numbered consecutively for easy reference.

---

### Q-01 · Multi-Site Tenancy Model 
- **Question**: The prompt mentions the Administrator "configures sites." Does a single WOGC instance manage one site at a time, or does it support multi-site configuration where data is partitioned by site?
- **Understanding**: "Configures sites" (plural) implies a multi-site management capability within a single console instance. Restricting the app to one site would narrow the scope and weaken the requirement.
- **Solution**: The system supports multi-site configuration. The Administrator manages a list of sites; users (Dispatchers, Operators) are assigned to specific sites. A global site selector in the header controls the active operational context (Queues, Calendar, Equipment).

### Q-02 · User Management & Account Lifecycle 
- **Question**: The prompt defines five roles but does not specify how accounts are created or who manages them.
- **Understanding**: A governance-focused warehouse system requires controlled access. Self-registration is unlikely; an administrative CRUD surface is necessary for role and site assignment.
- **Solution**: The Administrator role includes a full User Management interface to create, edit, and deactivate accounts. On initial application launch, a "First-Run Wizard" prompts for the creation of the primary Administrator account.

### Q-03 · Calendar "Capacity" Definition 
- **Question**: The Calendar aggregates "occupancy, temporary holds, maintenance lockouts, and capacity." What specific entity's capacity is being tracked?
- **Understanding**: In a warehouse/logistics context, capacity most often refers to physical storage (bins/zones). Tracking equipment or personnel capacity would conflict with the separate Equipment and Task modules.
- **Solution**: Capacity refers to **Bin/Location Occupancy** per zone. The Calendar visualizes the percentage of "Free vs. Occupied vs. Held" storage slots for each date, allowing planners to see when a site will reach physical saturation.

### Q-04 · Resolution to Task Routing 
- **Question**: Meeting resolutions are broken into "executable tasks." Are these added to the standard warehouse queue (picking/putaway) or a separate governance checklist?
- **Understanding**: Some resolutions are operational ("Move this pallet") while others are administrative ("Update this PDF"). Limiting to one type would fail to support the "Governance" aspect of the console.
- **Solution**: The Facilitator chooses the task type. "Operational" tasks are pushed directly to the Warehouse Queue Board. "Governance" tasks are tracked within a separate Action Items list in the Meeting Workspace.

### Q-05 · Session Auto-Lock Behavior 
- **Question**: "Sessions auto-lock after 15 minutes idle." Does this force a full logout or just a lock screen?
- **Understanding**: Warehouse operators frequently step away from consoles. A full logout would cause loss of unsaved work in the Meeting Workspace or Conflict Resolver, causing significant frustration.
- **Solution**: Auto-lock triggers a **Lock Screen Overlay**. The application state is preserved in memory, but all UI interaction is blocked until the user re-enters their password.

### Q-06 · Sensitive Field Masking Scope 
- **Question**: Which roles are permitted to see unmasked sensitive fields (names, badge IDs)?
- **Understanding**: Masking is a privacy/governance requirement. Only roles with a clear "need-to-know" (audit or management) should see full details.
- **Solution**: 
    - **Full View**: Administrator, Auditor.
    - **Contextual View**: Dispatchers (see names for assignment), Facilitators (see names for attendance).
    - **Masked View**: Floor Operators see only their own data; others are masked (e.g., "J*** D**").

### Q-07 · Task Expiry Lifecycle 
- **Question**: Tasks expire after 30 minutes if unacknowledged. Do they disappear or move to a specific state?
- **Understanding**: Silently deleting tasks would lead to lost warehouse operations. The system must ensure "eventual consistency."
- **Solution**: Expired tasks move to an **"Expired"** status and are automatically unassigned. They return to the top of the "Pending" queue with a visual "Previously Expired" flag to alert the Dispatcher that the work has been delayed.

### Q-08 · Conflict Resolver Trigger Conditions 
- **Question**: When exactly does the Conflict Resolver Modal fire?
- **Understanding**: The system requires a "deterministic" resolution for double-assigned resources. This can happen during manual assignment or if the event bus identifies a background conflict.
- **Solution**: The modal is a blocking "Guard." It fires (1) when a Dispatcher attempts to assign a task to a bin/equipment already in use, and (2) immediately upon login if the event bus identifies a background conflict. The UI is locked until a resolution reason is provided.

### Q-09 · Template Scope 
- **Question**: The Administrator "configures templates." What specifically is being templated?
- **Understanding**: Templating is most useful for repetitive, structured data entry in the two main workflows: work execution and meetings.
- **Solution**: Templates cover **Task Templates** (pre-defined priority/instructions for Putaway, Picking, etc.) and **Agenda Templates** (pre-defined topic structures for shift handovers or safety meetings).

### Q-10 · Import/Export Permissions & Format 
- **Question**: What is the scope of the import/export feature and who can use it?
- **Understanding**: This is a high-risk security feature (data exfiltration). It must be strictly restricted to the highest authority.
- **Solution**: Restricted to **Administrators only**. "Export" produces a full database backup in encrypted JSON (AES-GCM). "Import" allows for restoring from a backup or bulk-loading site configurations (Sites/Zones/Equipment) from a trusted JSON file.

### Q-11 · Priority Scale Direction 
- **Question**: For the 1–5 task priority scale, which number represents the highest urgency?
- **Understanding**: Standard industry convention (P1 vs. P5) usually treats 1 as the highest priority, but some systems reverse this.
- **Solution**: Priority 1 = Highest (Urgent), Priority 5 = Lowest (Routine).

### Q-12 · Heartbeat Strategy — Simulated vs. Real 
- **Question**: Should the 20-second timeout alert fire based on real-time passage or a simulated logical clock?
- **Understanding**: Although "simulating" adapters, the UI needs to behave realistically. An alert that fires based on real wall-clock time is more intuitive for user interaction.
- **Solution**: Real-time passage. The system tracks the `lastHeartbeatAt` timestamp and triggers the "Red" (timeout) state and subsequent alert if `now() - lastHeartbeatAt > 20s`.

### Q-13 · Meeting Attendance Sign-In 
- **Question**: Is the attendance sign-in self-service or facilitator-driven?
- **Understanding**: Governance workflows usually have a mix—attendees sign themselves in, but a facilitator provides the authoritative confirmation for attendance records.
- **Solution**: Hybrid. Attendees can self-check-in upon joining the Workspace, but the Facilitator retains the authoritative toggle to mark any user as Present/Absent/Late.

### Q-14 · Read Receipt Visibility 
- **Question**: Who can see the read receipts and the delivery log?
- **Understanding**: Read receipts provide accountability and proof of communication for governance and safety.
- **Solution**: Recipients see their own read status. Administrators and Auditors see the "Global Delivery Log" to verify that mandatory alerts were actually opened by recipients.

### Q-15 · Adapter Configuration Surface 
- **Question**: What constitutes "configuring" a simulated adapter?
- **Understanding**: To be useful for warehouse modeling, the Administrator should be able to tune the simulation parameters.
- **Solution**: Administrators define the adapter's **simulated latency** range (min/max ms), **failure probability**, and **heartbeat frequency**.

### Q-16 · Mobile Support Expectations 
- **Question**: How should the "dense operational screens" (Queue Board, Calendar) adapt to mobile?
- **Understanding**: Full queue management on a 5-inch screen is impractical. Mobile users are likely Floor Operators or roaming Auditors.
- **Solution**: Desktop/Tablet (768px+) are the primary targets for dense management. On Mobile (<768px), the UI collapses to a **Task-Centric view** focused on acknowledgment and notification lists rather than the full table-drawer dashboard.

### Q-17 · Dead-Letter List Resolution 
- **Question**: What happens to an event after it enters the Dead-Letter Queue (DLQ)?
- **Understanding**: DLQ events are system failures that need human intervention or oversight.
- **Solution**: Administrators can **Inspect**, **Retry** (once), or **Dismiss** (with mandatory reason) dead-lettered events. Dismissed events remain in a "History" view for auditing but are no longer active in the bus.
