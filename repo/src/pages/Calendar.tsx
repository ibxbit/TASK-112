import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useSelector } from "react-redux";
import { dal } from "../db/dal";
import type { CalendarCapacityRecord, CalendarEventRecord, CalendarHoldRecord, CalendarLockoutRecord, TaskRecord, UserRole } from "../db/schema";
import type { RootState } from "../store";
import { WOGCError } from "../utils/errors";
import { usePermissions } from "../hooks/usePermissions";
import Can from "../components/Can";
import { useToast } from "../hooks/useToast";

type CalendarMode = "day" | "week" | "month";
type CalendarRow = CalendarEventRecord & { id: number };
type TaskRow = TaskRecord & { id: number };
type CapacityRow = CalendarCapacityRecord & { id: number };
type LockoutRow = CalendarLockoutRecord & { id: number };
type HoldRow = CalendarHoldRecord & { id: number };

const canReschedule = (role: UserRole | null): boolean => role === "administrator" || role === "dispatcher" || role === "facilitator";

const startOfDay = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date: Date, days: number): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

const eventColor = (event: CalendarEventRecord): string => {
  if (event.eventType === "task") {
    return "#1d4ed8";
  }
  if (event.eventType === "maintenance") {
    return "#b54708";
  }
  if (event.eventType === "meeting") {
    return "#7c3aed";
  }
  if (event.eventType === "shift") {
    return "#047857";
  }
  return "#475569";
};

const expandRecurring = (events: CalendarRow[], rangeStart: Date, rangeEnd: Date): CalendarRow[] => {
  const out: CalendarRow[] = [];
  for (const event of events) {
    const recurrence = event.recurrenceRule ?? "none";
    if (recurrence === "none") {
      out.push(event);
      continue;
    }

    let cursor = new Date(event.startAt);
    const originalEnd = new Date(event.endAt);
    let guard = 0;
    while (cursor <= rangeEnd && guard < 200) {
      guard += 1;
      const spanMs = originalEnd.getTime() - new Date(event.startAt).getTime();
      if (cursor >= rangeStart && cursor <= rangeEnd) {
        out.push({
          ...event,
          id: Number(`${event.id}${guard}`),
          startAt: cursor.toISOString(),
          endAt: new Date(cursor.getTime() + spanMs).toISOString(),
        });
      }
      if (recurrence === "daily") {
        cursor = addDays(cursor, 1);
      } else if (recurrence === "weekly") {
        cursor = addDays(cursor, 7);
      } else {
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate(), cursor.getHours(), cursor.getMinutes());
      }
    }
  }
  return out;
};

export default function Calendar(): JSX.Element {
  const role = useSelector((state: RootState) => state.auth.role);
  const { can } = usePermissions();
  const toast = useToast();
  const [mode, setMode] = useState<CalendarMode>("week");
  const [anchor, setAnchor] = useState<Date>(new Date());
  const [events, setEvents] = useState<CalendarRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [capacities, setCapacities] = useState<CapacityRow[]>([]);
  const [lockouts, setLockouts] = useState<LockoutRow[]>([]);
  const [holds, setHolds] = useState<HoldRow[]>([]);
  const [draggedEvent, setDraggedEvent] = useState<CalendarRow | null>(null);
  const [pendingConflict, setPendingConflict] = useState<{ message: string; details?: Record<string, unknown>; payload: Omit<CalendarEventRecord, "id"> | null }>({ message: "", payload: null });
  const [draft, setDraft] = useState({
    title: "",
    eventType: "meeting" as NonNullable<CalendarEventRecord["eventType"]>,
    recurrenceRule: "none" as NonNullable<CalendarEventRecord["recurrenceRule"]>,
    resourceId: "",
    startAt: "",
    endAt: "",
  });
  const [capacityDraft, setCapacityDraft] = useState({ resourceId: "", slotStart: "", slotEnd: "", maxOccupancy: 1 });
  const [lockoutDraft, setLockoutDraft] = useState({ resourceId: "", reason: "", startAt: "", endAt: "" });
  const [holdDraft, setHoldDraft] = useState({ title: "", resourceId: "", startAt: "", endAt: "", expiresAt: "" });

  const load = async (): Promise<void> => {
    try {
      await dal.expireCalendarHoldsNow();
      const [calendarRows, taskRows, capacityRows, lockoutRows, holdRows] = await Promise.all([
        dal.listCalendarEvents(),
        dal.listTasks(),
        dal.listCalendarCapacities(),
        dal.listCalendarLockouts(),
        dal.listCalendarHolds(),
      ]);
      setEvents(calendarRows);
      setTasks(taskRows);
      setCapacities(capacityRows);
      setLockouts(lockoutRows);
      setHolds(holdRows);
    } catch (error) {
      if (error instanceof WOGCError) {
        toast.error(`${error.code}: ${error.message}`);
      }
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const slotRange = useMemo(() => {
    const day = startOfDay(anchor);
    if (mode === "day") {
      return Array.from({ length: 24 }, (_, index) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), index));
    }
    if (mode === "week") {
      const start = addDays(day, -day.getDay());
      return Array.from({ length: 7 }, (_, index) => addDays(start, index));
    }
    const start = new Date(day.getFullYear(), day.getMonth(), 1);
    const count = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
    return Array.from({ length: count }, (_, index) => addDays(start, index));
  }, [anchor, mode]);

  const taskDueEvents = useMemo<CalendarRow[]>(() => {
    return tasks
      .filter((task) => typeof task.dueDate === "string")
      .map((task) => ({
        id: Number(`8${task.id}`),
        title: `Task: ${task.title}`,
        eventType: "task",
        category: "occupancy",
        resourceId: task.resourceId,
        recurrenceRule: "none",
        startAt: task.dueDate as string,
        endAt: new Date(Date.parse(task.dueDate as string) + 60 * 60 * 1000).toISOString(),
      }));
  }, [tasks]);

  const holdEvents = useMemo<CalendarRow[]>(() => {
    return holds
      .filter((hold) => hold.status === "active")
      .map((hold) => ({
        id: Number(`9${hold.id}`),
        title: `Hold: ${hold.title}`,
        eventType: "shift",
        category: "holds",
        resourceId: hold.resourceId,
        recurrenceRule: "none",
        startAt: hold.startAt,
        endAt: hold.endAt,
      }));
  }, [holds]);

  const visibleEvents = useMemo(() => {
    const merged = [...events, ...taskDueEvents, ...holdEvents];
    const rangeStart = slotRange[0];
    const rangeEnd = slotRange[slotRange.length - 1];
    return expandRecurring(merged, rangeStart, new Date(rangeEnd.getTime() + 24 * 60 * 60 * 1000));
  }, [events, taskDueEvents, holdEvents, slotRange]);

  const eventsBySlot = useMemo(() => {
    const map = new Map<string, CalendarRow[]>();
    for (const slot of slotRange) {
      map.set(slot.toDateString(), []);
    }
    for (const event of visibleEvents) {
      const key = new Date(event.startAt).toDateString();
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)?.push(event);
    }
    return map;
  }, [visibleEvents, slotRange]);

  const occupancyBySlot = useMemo(() => {
    const map = new Map<string, { current: number; max: number | null }>();
    for (const slot of slotRange) {
      const key = slot.toDateString();
      const items = eventsBySlot.get(key) ?? [];
      const matchingCapacity = capacities.find((row) => {
        const slotStart = new Date(slot.getFullYear(), slot.getMonth(), slot.getDate()).toISOString();
        const slotEnd = new Date(slot.getFullYear(), slot.getMonth(), slot.getDate() + 1).toISOString();
        return Date.parse(row.slotStart) < Date.parse(slotEnd) && Date.parse(row.slotEnd) > Date.parse(slotStart);
      });
      map.set(key, { current: items.length, max: matchingCapacity?.maxOccupancy ?? null });
    }
    return map;
  }, [slotRange, eventsBySlot, capacities]);

  const lockoutsBySlot = useMemo(() => {
    const map = new Map<string, LockoutRow[]>();
    for (const slot of slotRange) {
      const key = slot.toDateString();
      const slotStart = new Date(slot.getFullYear(), slot.getMonth(), slot.getDate()).toISOString();
      const slotEnd = new Date(slot.getFullYear(), slot.getMonth(), slot.getDate() + 1).toISOString();
      const matches = lockouts.filter((lockout) => Date.parse(lockout.startAt) < Date.parse(slotEnd) && Date.parse(lockout.endAt) > Date.parse(slotStart));
      map.set(key, matches);
    }
    return map;
  }, [slotRange, lockouts]);

  const shiftAnchor = (days: number): void => setAnchor((prev) => addDays(prev, days));

  const dropOnSlot = async (slot: Date): Promise<void> => {
    if (!draggedEvent) {
      return;
    }
    if (!canReschedule(role)) {
      toast.permissionError("You don't have permission to reschedule calendar events. Contact your administrator.");
      return;
    }
    const start = new Date(draggedEvent.startAt);
    const end = new Date(draggedEvent.endAt);
    const span = end.getTime() - start.getTime();
    const nextStart = new Date(slot.getFullYear(), slot.getMonth(), slot.getDate(), start.getHours(), start.getMinutes());
    const nextPayload: Omit<CalendarEventRecord, "id"> = {
      title: draggedEvent.title,
      eventType: draggedEvent.eventType,
      recurrenceRule: draggedEvent.recurrenceRule,
      category: draggedEvent.category,
      resourceId: draggedEvent.resourceId,
      startAt: nextStart.toISOString(),
      endAt: new Date(nextStart.getTime() + span).toISOString(),
    };
    try {
      await dal.upsertCalendarEvent({
        ...draggedEvent,
        id: String(draggedEvent.id).startsWith("8") ? undefined : draggedEvent.id,
        ...nextPayload,
      });
      await load();
      toast.success("Event rescheduled.");
    } catch (error) {
      if (error instanceof WOGCError && (error.code === "CAPACITY_CONFLICT" || error.code === "LOCKOUT_CONFLICT")) {
        setPendingConflict({
          message: error.message,
          details: error.context as Record<string, unknown>,
          payload: nextPayload,
        });
      } else {
        toast.fromError(error, "Calendar reschedule failed.");
      }
    } finally {
      setDraggedEvent(null);
    }
  };

  const maintenanceTooltip = (event: CalendarRow): string => {
    if (event.eventType !== "maintenance") {
      return event.title;
    }
    const heartbeat = tasks.find((task) => task.resourceId === event.resourceId);
    const status = heartbeat ? `related tasks: ${heartbeat.status}` : "no linked task";
    return `${event.title} (${status})`;
  };

  const createEvent = async (): Promise<void> => {
    if (!canReschedule(role)) {
      toast.permissionError("You don't have permission to create calendar events. Contact your administrator.");
      return;
    }
    if (!draft.title || !draft.startAt || !draft.endAt) {
      toast.warning("Provide title, start and end to create event.");
      return;
    }
    try {
      await dal.saveCalendarEvent({
        title: draft.title,
        eventType: draft.eventType,
        recurrenceRule: draft.recurrenceRule,
        category: draft.eventType === "maintenance" ? "maintenance" : "occupancy",
        resourceId: draft.resourceId || undefined,
        startAt: new Date(draft.startAt).toISOString(),
        endAt: new Date(draft.endAt).toISOString(),
      });
      setDraft({ title: "", eventType: "meeting", recurrenceRule: "none", resourceId: "", startAt: "", endAt: "" });
      await load();
      toast.success("Calendar event created.");
    } catch (error) {
      if (error instanceof WOGCError && (error.code === "CAPACITY_CONFLICT" || error.code === "LOCKOUT_CONFLICT")) {
        setPendingConflict({
          message: error.message,
          details: error.context as Record<string, unknown>,
          payload: {
            title: draft.title,
            eventType: draft.eventType,
            recurrenceRule: draft.recurrenceRule,
            category: draft.eventType === "maintenance" ? "maintenance" : "occupancy",
            resourceId: draft.resourceId || undefined,
            startAt: new Date(draft.startAt).toISOString(),
            endAt: new Date(draft.endAt).toISOString(),
          },
        });
      } else {
        toast.fromError(error, "Calendar event creation failed.");
      }
    }
  };

  const saveCapacity = async (): Promise<void> => {
    try {
      await dal.saveCalendarCapacity({
        resourceId: capacityDraft.resourceId || undefined,
        slotStart: new Date(capacityDraft.slotStart).toISOString(),
        slotEnd: new Date(capacityDraft.slotEnd).toISOString(),
        maxOccupancy: capacityDraft.maxOccupancy,
      });
      toast.success("Capacity rule saved.");
      await load();
    } catch (error) {
      toast.fromError(error, "Failed to save capacity rule.");
    }
  };

  const saveLockout = async (): Promise<void> => {
    try {
      await dal.saveCalendarLockout({
        resourceId: lockoutDraft.resourceId || undefined,
        reason: lockoutDraft.reason,
        startAt: new Date(lockoutDraft.startAt).toISOString(),
        endAt: new Date(lockoutDraft.endAt).toISOString(),
      });
      toast.success("Lockout created.");
      await load();
    } catch (error) {
      toast.fromError(error, "Failed to save lockout.");
    }
  };

  const saveHold = async (): Promise<void> => {
    try {
      await dal.saveCalendarHold({
        title: holdDraft.title,
        resourceId: holdDraft.resourceId || undefined,
        startAt: new Date(holdDraft.startAt).toISOString(),
        endAt: new Date(holdDraft.endAt).toISOString(),
        expiresAt: new Date(holdDraft.expiresAt).toISOString(),
      });
      toast.success("Temporary hold created.");
      await load();
    } catch (error) {
      toast.fromError(error, "Failed to create hold.");
    }
  };

  const resolveConflictWithOverride = async (): Promise<void> => {
    if (!pendingConflict.payload) {
      return;
    }
    try {
      await dal.saveCalendarEvent(pendingConflict.payload, { allowOverride: true, overrideReason: "user_requested_override" });
      toast.warning("Override accepted and logged to audit trail.");
      setPendingConflict({ message: "", payload: null });
      await load();
    } catch (error) {
      toast.fromError(error, "Override request failed.");
    }
  };

  return (
    <main style={{ padding: "1rem", display: "grid", gap: "0.75rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
        <h2>Operational Calendar</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button type="button" onClick={() => shiftAnchor(mode === "month" ? -30 : mode === "week" ? -7 : -1)}>Prev</button>
          <button type="button" onClick={() => setAnchor(new Date())}>Today</button>
          <button type="button" onClick={() => shiftAnchor(mode === "month" ? 30 : mode === "week" ? 7 : 1)}>Next</button>
          <select value={mode} onChange={(event) => setMode(event.target.value as CalendarMode)}>
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </div>
      </header>
      <Can permission="calendar:create" fallback={<p className="readonly-note">Read-only scope: calendar creation controls are not available for your role.</p>}>
        <section className="card" style={{ display: "grid", gap: "0.5rem" }}>
          <h3 style={{ margin: 0 }}>Create Scheduled/Recurring Event</h3>
          <div className="row-wrap">
            <input placeholder="title" value={draft.title} onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))} />
            <select value={draft.eventType} onChange={(event) => setDraft((prev) => ({ ...prev, eventType: event.target.value as NonNullable<CalendarEventRecord["eventType"]> }))}>
              <option value="task">Task</option>
              <option value="maintenance">Maintenance</option>
              <option value="meeting">Meeting</option>
              <option value="shift">Shift</option>
            </select>
            <select value={draft.recurrenceRule} onChange={(event) => setDraft((prev) => ({ ...prev, recurrenceRule: event.target.value as NonNullable<CalendarEventRecord["recurrenceRule"]> }))}>
              <option value="none">No recurrence</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
            <input placeholder="resource" value={draft.resourceId} onChange={(event) => setDraft((prev) => ({ ...prev, resourceId: event.target.value }))} />
            <input type="datetime-local" value={draft.startAt} onChange={(event) => setDraft((prev) => ({ ...prev, startAt: event.target.value }))} />
            <input type="datetime-local" value={draft.endAt} onChange={(event) => setDraft((prev) => ({ ...prev, endAt: event.target.value }))} />
            <button type="button" onClick={() => void createEvent()}>Create Event</button>
          </div>
        </section>
      </Can>

      <Can permission="calendar:create" fallback={null}>
        <section className="card" style={{ display: "grid", gap: "0.5rem" }}>
          <h3 style={{ margin: 0 }}>Capacity / Lockout / Holds</h3>
          <div className="row-wrap">
            <input placeholder="capacity resource" value={capacityDraft.resourceId} onChange={(event) => setCapacityDraft((prev) => ({ ...prev, resourceId: event.target.value }))} />
            <input type="datetime-local" value={capacityDraft.slotStart} onChange={(event) => setCapacityDraft((prev) => ({ ...prev, slotStart: event.target.value }))} />
            <input type="datetime-local" value={capacityDraft.slotEnd} onChange={(event) => setCapacityDraft((prev) => ({ ...prev, slotEnd: event.target.value }))} />
            <input type="number" min={1} value={capacityDraft.maxOccupancy} onChange={(event) => setCapacityDraft((prev) => ({ ...prev, maxOccupancy: Number(event.target.value) || 1 }))} />
            <button type="button" onClick={() => void saveCapacity()}>Save Capacity</button>
          </div>
          <div className="row-wrap">
            <input placeholder="lockout resource" value={lockoutDraft.resourceId} onChange={(event) => setLockoutDraft((prev) => ({ ...prev, resourceId: event.target.value }))} />
            <input placeholder="lockout reason" value={lockoutDraft.reason} onChange={(event) => setLockoutDraft((prev) => ({ ...prev, reason: event.target.value }))} />
            <input type="datetime-local" value={lockoutDraft.startAt} onChange={(event) => setLockoutDraft((prev) => ({ ...prev, startAt: event.target.value }))} />
            <input type="datetime-local" value={lockoutDraft.endAt} onChange={(event) => setLockoutDraft((prev) => ({ ...prev, endAt: event.target.value }))} />
            <button type="button" onClick={() => void saveLockout()}>Save Lockout</button>
          </div>
          <div className="row-wrap">
            <input placeholder="hold title" value={holdDraft.title} onChange={(event) => setHoldDraft((prev) => ({ ...prev, title: event.target.value }))} />
            <input placeholder="hold resource" value={holdDraft.resourceId} onChange={(event) => setHoldDraft((prev) => ({ ...prev, resourceId: event.target.value }))} />
            <input type="datetime-local" value={holdDraft.startAt} onChange={(event) => setHoldDraft((prev) => ({ ...prev, startAt: event.target.value }))} />
            <input type="datetime-local" value={holdDraft.endAt} onChange={(event) => setHoldDraft((prev) => ({ ...prev, endAt: event.target.value }))} />
            <input type="datetime-local" value={holdDraft.expiresAt} onChange={(event) => setHoldDraft((prev) => ({ ...prev, expiresAt: event.target.value }))} />
            <button type="button" onClick={() => void saveHold()}>Create Hold</button>
          </div>
        </section>
      </Can>

      <section style={{ display: "grid", gridTemplateColumns: mode === "day" ? "1fr" : "repeat(auto-fit, minmax(10rem, 1fr))", gap: "0.6rem" }}>
        {slotRange.map((slot) => {
          const key = slot.toDateString();
          const list = eventsBySlot.get(key) ?? [];
          const occupancy = occupancyBySlot.get(key);
          const slotLockouts = lockoutsBySlot.get(key) ?? [];
          const ratio = occupancy?.max ? Math.min(1, occupancy.current / occupancy.max) : 0;
          const barColor = !occupancy?.max ? "#94a3b8" : ratio > 1 ? "#b42318" : ratio > 0.8 ? "#b54708" : "#047857";
          return (
            <article
              key={`${key}-${slot.getHours()}`}
              style={{
                ...slotCard,
                background: slotLockouts.length > 0
                  ? "repeating-linear-gradient(45deg, #fee2e2 0, #fee2e2 6px, #fecaca 6px, #fecaca 12px)"
                  : slotCard.background,
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => void dropOnSlot(slot)}
              title={slotLockouts.map((item) => item.reason).join(", ")}
            >
              <header style={{ marginBottom: "0.4rem", fontWeight: 700 }}>
                {mode === "day" ? `${slot.getHours().toString().padStart(2, "0")}:00` : slot.toDateString()}
              </header>
              <div style={{ marginBottom: "0.35rem" }}>
                <div style={{ fontSize: "0.74rem", color: "#334155" }}>Capacity {occupancy?.max ? `${occupancy.current}/${occupancy.max}` : `${occupancy?.current ?? 0}/-`}</div>
                <div style={{ height: "6px", borderRadius: "999px", background: "#e2e8f0", overflow: "hidden" }}>
                  <div style={{ width: `${Math.round(ratio * 100)}%`, height: "100%", background: barColor }} />
                </div>
              </div>
              {slotLockouts.length > 0 ? <p style={{ margin: "0 0 0.35rem 0", color: "#991b1b", fontSize: "0.75rem" }}>Lockout active</p> : null}
              <div style={{ display: "grid", gap: "0.35rem" }}>
                {list.map((event) => (
                  <div
                    key={`${event.id}-${event.startAt}`}
                    draggable={can("calendar:reschedule")}
                    onDragStart={() => setDraggedEvent(event)}
                    title={maintenanceTooltip(event)}
                    style={{
                      borderRadius: "8px",
                      padding: "0.3rem 0.45rem",
                      color: "#fff",
                      background: eventColor(event),
                      cursor: can("calendar:reschedule") ? "grab" : "default",
                      fontSize: "0.82rem",
                    }}
                  >
                    <strong>{event.title}</strong>
                    <div>{new Date(event.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                  </div>
                ))}
              </div>
            </article>
          );
        })}
      </section>

      {pendingConflict.payload ? (
        <div style={conflictOverlay} role="dialog" aria-modal="true" aria-label="Calendar conflict resolution">
          <section style={conflictPanel}>
            <h3 style={{ marginTop: 0 }}>Scheduling Conflict</h3>
            <p style={{ marginTop: 0 }}>{pendingConflict.message}</p>
            <p style={{ fontSize: "0.82rem", color: "#475569" }}>{JSON.stringify(pendingConflict.details ?? {}, null, 2)}</p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.45rem" }}>
              <button type="button" onClick={() => setPendingConflict({ message: "", payload: null })}>Cancel</button>
              <button
                type="button"
                onClick={() => {
                  if (!pendingConflict.payload) {
                    return;
                  }
                  const start = new Date(pendingConflict.payload.startAt);
                  const end = new Date(pendingConflict.payload.endAt);
                  const shifted: Omit<CalendarEventRecord, "id"> = {
                    ...pendingConflict.payload,
                    startAt: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
                    endAt: new Date(end.getTime() + 60 * 60 * 1000).toISOString(),
                  };
                  setPendingConflict({ message: "", payload: shifted });
                  toast.info("Rescheduled proposal by +1 hour. Submit again or request override.");
                }}
              >
                Reschedule +1h
              </button>
              <button type="button" onClick={() => void resolveConflictWithOverride()}>Request Override</button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

const slotCard: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "12px",
  background: "var(--surface)",
  padding: "0.5rem",
  minHeight: "8rem",
};

const conflictOverlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(16, 24, 40, 0.4)",
  display: "grid",
  placeItems: "center",
  zIndex: 70,
};

const conflictPanel: CSSProperties = {
  width: "min(34rem, 92vw)",
  borderRadius: "12px",
  border: "1px solid #cbd5e1",
  background: "#fff",
  padding: "0.9rem",
};
