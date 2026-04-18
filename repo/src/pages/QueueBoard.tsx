import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useSelector } from "react-redux";
import ConflictResolverModal, { type QueueConflict } from "../components/ConflictResolverModal";
import { dal } from "../db/dal";
import type { TaskRecord, TaskWorkstream } from "../db/schema";
import { WOGCError } from "../utils/errors";
import { maskBadgeIdForRole, maskNameForRole } from "../utils/masking";
import type { RootState } from "../store";
import { usePermissions } from "../hooks/usePermissions";
import { useToast } from "../hooks/useToast";
import Can from "../components/Can";

type QueueTask = TaskRecord & { id: number };

const mapQueueError = (error: WOGCError): string => {
  if (error.code === "AUTH_403") {
    return "Permission denied for queue operation.";
  }
  if (error.code === "DB_READ_FAIL") {
    return "Queue read failed. Retry when storage is available.";
  }
  if (error.code === "DB_WRITE_FAIL") {
    return "Queue update could not be stored.";
  }
  if (error.code === "VAL_PRIORITY_RANGE") {
    return "Priority must be an integer between 1 and 5.";
  }
  return `${error.code}: ${error.message}`;
};

export default function QueueBoard(): JSX.Element {
  const role = useSelector((state: RootState) => state.auth.role);
  const authUsername = useSelector((state: RootState) => state.auth.username);
  const { can } = usePermissions();
  const toast = useToast();
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [priorityFilter, setPriorityFilter] = useState<"all" | 1 | 2 | 3 | 4 | 5>("all");
  const [workstreamFilter, setWorkstreamFilter] = useState<"all" | TaskWorkstream>("all");
  const [sortByPriority, setSortByPriority] = useState(true);
  const [sortByWorkstream, setSortByWorkstream] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [priorityDraft, setPriorityDraft] = useState<1 | 2 | 3 | 4 | 5>(3);
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [badgeByUsername, setBadgeByUsername] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );

  useEffect(() => {
    if (selectedTask) {
      setPriorityDraft(selectedTask.priority ?? 3);
    }
  }, [selectedTask]);

  const visibleTasks = useMemo(() => {
    const filtered = tasks
      .filter((task) => (priorityFilter === "all" ? true : (task.priority ?? 3) === priorityFilter))
      .filter((task) => (workstreamFilter === "all" ? true : task.workstream === workstreamFilter))
      .filter((task) => (role === "operator" ? task.assignee === authUsername : true));
    if (sortByWorkstream) {
      return [...filtered].sort((a, b) => a.workstream.localeCompare(b.workstream));
    }
    if (sortByPriority) {
      return [...filtered].sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));
    }
    return filtered;
  }, [tasks, priorityFilter, role, authUsername, sortByPriority, sortByWorkstream, workstreamFilter]);

  const conflicts = useMemo<QueueConflict[]>(() => {
    const groups = new Map<string, QueueTask[]>();
    for (const task of tasks) {
      const key = task.resourceId?.trim();
      if (!key) {
        continue;
      }
      const existing = groups.get(key) ?? [];
      existing.push(task);
      groups.set(key, existing);
    }
    const conflictRows: QueueConflict[] = [];
    for (const [resourceId, rows] of groups.entries()) {
      if (rows.length < 2) {
        continue;
      }
      for (const row of rows) {
        conflictRows.push({
          taskId: row.id,
          taskTitle: row.title,
          resourceId,
          assignee: row.assignee,
        });
      }
    }
    return conflictRows;
  }, [tasks]);

  const loadQueue = async (): Promise<void> => {
    setLoading(true);
    try {
      const rows = await dal.listTasks();
      setTasks(rows);
      const usernames = Array.from(new Set(rows.map((row) => row.assignee).filter((value): value is string => Boolean(value))));
        const badgePairs = await Promise.all(usernames.map(async (username) => {
          const user = await dal.getUserProfileByUsername(username);
          return [username, user?.badgeId ?? ""] as const;
        }));
      setBadgeByUsername(Object.fromEntries(badgePairs));
      if (!selectedTaskId && rows.length > 0) {
        setSelectedTaskId(rows[0].id);
      }
    } catch (error) {
      if (error instanceof WOGCError) {
        toast.error(mapQueueError(error));
      } else {
        toast.error("Queue board failed with an unexpected error.");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadQueue();
  }, []);

  const completeTask = async (): Promise<void> => {
    if (!selectedTask || !can("tasks:complete")) {
      return;
    }
    try {
      await dal.saveTask({
        ...selectedTask,
        id: selectedTask.id,
        status: "done",
      });
      toast.success(`Task ${selectedTask.id} marked complete.`);
      await loadQueue();
    } catch (error) {
      toast.fromError(error, "Task completion failed.");
    }
  };

  const addComment = (): void => {
    if (!selectedTask || !can("tasks:comment")) {
      return;
    }
    toast.info(`Comment action opened for task ${selectedTask.id}.`);
  };

  const updatePriority = async (): Promise<void> => {
    if (!selectedTask || !can("tasks:update")) {
      return;
    }
    try {
      await dal.saveTask({
        ...selectedTask,
        id: selectedTask.id,
        priority: priorityDraft,
      });
      toast.success(`Task ${selectedTask.id} priority updated to P${priorityDraft}.`);
      await loadQueue();
    } catch (error) {
      toast.fromError(error, "Task priority update failed.");
    }
  };

  const reclassifyTask = async (taskId: number, next: TaskWorkstream): Promise<void> => {
    try {
      await dal.reclassifyTaskWorkstream(taskId, next);
      toast.success(`Task ${taskId} moved to ${next}.`);
      await loadQueue();
    } catch (error) {
      toast.fromError(error, "Workstream reclassification failed.");
    }
  };

  return (
    <main style={{ padding: "1rem", display: "grid", gap: "0.8rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
        <h2 style={{ margin: 0 }}>Queue Board</h2>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value === "all" ? "all" : Number(event.target.value) as 1 | 2 | 3 | 4 | 5)}>
            <option value="all">All Priorities</option>
            <option value="1">P1 Critical</option>
            <option value="2">P2 High</option>
            <option value="3">P3 Medium</option>
            <option value="4">P4 Low</option>
            <option value="5">P5 Backlog</option>
          </select>
          <select value={workstreamFilter} onChange={(event) => setWorkstreamFilter(event.target.value as "all" | TaskWorkstream)}>
            <option value="all">All Workstreams</option>
            <option value="putaway">Putaway</option>
            <option value="transport">Transport</option>
            <option value="picking">Picking</option>
            <option value="replenishment">Replenishment</option>
          </select>
          <button type="button" onClick={() => setSortByPriority((value) => !value)}>
            Sort by Priority: {sortByPriority ? "On" : "Off"}
          </button>
          <button type="button" onClick={() => setSortByWorkstream((value) => !value)}>
            Sort by Workstream: {sortByWorkstream ? "On" : "Off"}
          </button>
          <Can permission="tasks:resolve_conflict" fallback={null}>
            <button type="button" onClick={() => setShowConflictModal(true)} disabled={conflicts.length === 0}>
              Resolve Conflicts ({conflicts.length})
            </button>
          </Can>
        </div>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "0.8rem" }}>
        <div style={{ border: "1px solid #d5d5d5", overflow: "auto", maxHeight: "65vh" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
            <thead style={{ position: "sticky", top: 0, background: "#f3f0e8" }}>
              <tr>
                <th style={cellHead}>Task</th>
                <th style={cellHead}>Status</th>
                <th style={cellHead}>Priority</th>
                <th style={cellHead}>Workstream</th>
                <th style={cellHead}>Resource</th>
                <th style={cellHead}>Assignee</th>
                {role === "administrator" || role === "dispatcher" ? <th style={cellHead}>Reclassify</th> : null}
                <th style={cellHead}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {visibleTasks.map((task) => (
                <tr
                  key={task.id}
                  onClick={() => setSelectedTaskId(task.id)}
                  style={{
                    background: task.id === selectedTaskId ? "#dae8ff" : "transparent",
                    cursor: "pointer",
                  }}
                >
                  <td style={cellBody}>{task.title}</td>
                  <td style={cellBody}>{task.status}</td>
                  <td style={cellBody}><span style={priorityPill(task.priority ?? 3)}>P{task.priority ?? 3}</span></td>
                  <td style={cellBody}>{task.workstream}</td>
                  <td style={cellBody}>{task.resourceId ?? "-"}</td>
                  <td style={cellBody}>{`${maskNameForRole(task.assignee ?? "-", role)} [${maskBadgeIdForRole(badgeByUsername[task.assignee ?? ""] ?? "-", role)}]`}</td>
                  {role === "administrator" || role === "dispatcher" ? (
                    <td style={cellBody}>
                      <select value={task.workstream} onChange={(event) => void reclassifyTask(task.id, event.target.value as TaskWorkstream)}>
                        <option value="putaway">putaway</option>
                        <option value="transport">transport</option>
                        <option value="picking">picking</option>
                        <option value="replenishment">replenishment</option>
                      </select>
                    </td>
                  ) : null}
                  <td style={cellBody}>{new Date(task.updatedAt).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading ? <p style={{ margin: "0.5rem" }}>Loading queue...</p> : null}
        </div>

        <aside style={{ border: "1px solid #d5d5d5", padding: "0.75rem", background: "#fbfbfd" }}>
          <h3 style={{ marginTop: 0 }}>Task Drawer</h3>
          {selectedTask ? (
            <>
              <dl style={{ margin: 0, display: "grid", gap: "0.5rem" }}>
                <div>
                  <dt style={drawerKey}>Task ID</dt>
                  <dd style={drawerVal}>{selectedTask.id}</dd>
                </div>
                <div>
                  <dt style={drawerKey}>Title</dt>
                  <dd style={drawerVal}>{selectedTask.title}</dd>
                </div>
                <div>
                  <dt style={drawerKey}>Status</dt>
                  <dd style={drawerVal}>{selectedTask.status}</dd>
                </div>
                <div>
                  <dt style={drawerKey}>Priority</dt>
                  <dd style={drawerVal}>
                    {can("tasks:update") ? (
                      <span style={{ display: "inline-flex", gap: "0.35rem", alignItems: "center" }}>
                        <label htmlFor="task-priority" style={{ fontWeight: 500 }}>P</label>
                        <select
                          id="task-priority"
                          value={priorityDraft}
                          onChange={(event) => setPriorityDraft(Number(event.target.value) as 1 | 2 | 3 | 4 | 5)}
                        >
                          <option value={1}>1</option>
                          <option value={2}>2</option>
                          <option value={3}>3</option>
                          <option value={4}>4</option>
                          <option value={5}>5</option>
                        </select>
                        <button type="button" onClick={() => void updatePriority()} disabled={priorityDraft < 1 || priorityDraft > 5}>Apply</button>
                      </span>
                    ) : (
                      <span>P{selectedTask.priority ?? 3}</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt style={drawerKey}>Resource</dt>
                  <dd style={drawerVal}>{selectedTask.resourceId ?? "none"}</dd>
                </div>
                <div>
                  <dt style={drawerKey}>Assignee</dt>
                  <dd style={drawerVal}>{maskNameForRole(selectedTask.assignee ?? "unassigned", role)}</dd>
                </div>
                <div>
                  <dt style={drawerKey}>Updated</dt>
                  <dd style={drawerVal}>{new Date(selectedTask.updatedAt).toLocaleString()}</dd>
                </div>
              </dl>
              {can("tasks:complete") || can("tasks:comment") ? (
                <div style={{ display: "flex", gap: "0.45rem", marginTop: "0.75rem" }}>
                  {can("tasks:complete") ? <button type="button" onClick={() => void completeTask()}>Complete Task</button> : null}
                  {can("tasks:comment") ? <button type="button" onClick={addComment}>Comment</button> : null}
                </div>
              ) : null}
            </>
          ) : (
            <p style={{ margin: 0 }}>Select a row to inspect details.</p>
          )}
        </aside>
      </section>

      {!can("tasks:complete") && !can("tasks:comment") && !can("tasks:resolve_conflict") ? (
        <p className="readonly-note">Read-only mode: queue mutation controls are unavailable for your role scope.</p>
      ) : null}

      {can("tasks:resolve_conflict") ? (
        <ConflictResolverModal
          open={showConflictModal}
          conflicts={conflicts}
          onClose={() => setShowConflictModal(false)}
          onResolved={loadQueue}
        />
      ) : null}
    </main>
  );
}

const cellHead: CSSProperties = {
  textAlign: "left",
  padding: "0.45rem",
  borderBottom: "1px solid #c9c3b4",
};

const cellBody: CSSProperties = {
  padding: "0.45rem",
  borderBottom: "1px solid #ebebeb",
};

const drawerKey: CSSProperties = {
  color: "#5a5a5a",
  fontSize: "0.8rem",
};

const drawerVal: CSSProperties = {
  margin: 0,
  fontWeight: 600,
};

const priorityPill = (priority: 1 | 2 | 3 | 4 | 5): CSSProperties => {
  const color = priority === 1 ? "#b42318" : priority === 2 ? "#b54708" : priority === 3 ? "#1d4ed8" : priority === 4 ? "#047857" : "#475569";
  return {
    display: "inline-block",
    minWidth: "2.3rem",
    textAlign: "center",
    borderRadius: "999px",
    padding: "0.1rem 0.4rem",
    color: "#fff",
    background: color,
    fontSize: "0.78rem",
    fontWeight: 700,
  };
};
