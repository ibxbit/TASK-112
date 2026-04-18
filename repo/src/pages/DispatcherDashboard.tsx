import { useEffect, useMemo, useState } from "react";
import { dal } from "../db/dal";
import { eventBus } from "../services/EventBus";
import type { EquipmentHeartbeatRecord, TaskRecord } from "../db/schema";
import { WOGCError } from "../utils/errors";
import { maskNameForRole } from "../utils/masking";
import { useSelector } from "react-redux";
import type { RootState } from "../store";
import { usePermissions } from "../hooks/usePermissions";
import { useToast } from "../hooks/useToast";

type TaskRow = TaskRecord & { id: number };
type HeartbeatRow = EquipmentHeartbeatRecord & { id: number };

export default function DispatcherDashboard(): JSX.Element {
  const role = useSelector((state: RootState) => state.auth.role);
  const { can } = usePermissions();
  const toast = useToast();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [heartbeats, setHeartbeats] = useState<HeartbeatRow[]>([]);
  const [assignmentDraftByTaskId, setAssignmentDraftByTaskId] = useState<Record<number, string>>({});

  const load = async (): Promise<void> => {
    try {
      const [taskRows, heartbeatRows] = await Promise.all([dal.listTasks(), dal.listHeartbeats(120)]);
      setTasks(taskRows);
      setHeartbeats(heartbeatRows);
    } catch (error) {
      if (error instanceof WOGCError) {
        toast.error(`${error.code}: ${error.message}`);
      }
    }
  };

  useEffect(() => {
    void load();
    const unsubExpired = eventBus.subscribe("tasks.expired", async () => {
      toast.info("Task expiry event received.");
      await load();
    });
    const unsubTimeout = eventBus.subscribe("equipment.heartbeat.timeout", async () => {
      toast.warning("Heartbeat missed event received.");
      await load();
    });
    return () => {
      unsubExpired();
      unsubTimeout();
    };
  }, []);

  const prioritizedTasks = useMemo(() => {
    const rank = (status: TaskRow["status"]): number => {
      if (status === "expired") {
        return 0;
      }
      if (status === "open") {
        return 1;
      }
      if (status === "in_progress") {
        return 2;
      }
      return 3;
    };
    return [...tasks].sort((a, b) => rank(a.status) - rank(b.status));
  }, [tasks]);

  const statusFromHeartbeat = (heartbeat: HeartbeatRow): string => {
    const age = Date.now() - Date.parse(heartbeat.observedAt);
    if (age > 20_000) {
      return "heartbeat_missed";
    }
    if (heartbeat.status === "timeout") {
      return "offline";
    }
    return "online";
  };

  const assignTask = async (taskId: number, assignee: string): Promise<void> => {
    const normalizedAssignee = assignee.trim();
    if (!normalizedAssignee) {
      toast.warning("Enter an assignee before submitting task assignment.");
      return;
    }
    try {
      const target = tasks.find((task) => task.id === taskId);
      if (!target) {
        return;
      }
      await dal.saveTask({
        ...target,
        id: taskId,
        assignee: normalizedAssignee,
      });
      toast.success(`Task ${taskId} assigned to ${normalizedAssignee}.`);
      await load();
    } catch (error) {
      if (error instanceof WOGCError) {
        toast.fromError(error, "Task assignment failed.");
      }
    }
  };

  return (
    <main style={{ padding: "1rem", display: "grid", gap: "0.75rem" }}>
      <h2>Dispatcher Dashboard</h2>

      <section className="card-grid">
        <article className="card" style={{ overflowX: "auto" }}>
          <h3>Priority Queue</h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>Task</th><th style={th}>Status</th><th style={th}>Assignee</th>{can("tasks:assign") ? <th style={th}>Action</th> : null}</tr></thead>
            <tbody>
              {prioritizedTasks.map((task) => (
                <tr key={task.id}>
                  <td style={td}>{task.title}</td>
                  <td style={td}>{task.status}</td>
                  <td style={td}>{maskNameForRole(task.assignee, role)}</td>
                  {can("tasks:assign") ? (
                    <td style={td}>
                      <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                        <input
                          placeholder="assignee"
                          value={assignmentDraftByTaskId[task.id] ?? ""}
                          onChange={(event) => setAssignmentDraftByTaskId((prev) => ({ ...prev, [task.id]: event.target.value }))}
                        />
                        <button type="button" onClick={() => void assignTask(task.id, assignmentDraftByTaskId[task.id] ?? "")}>Assign</button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          {!can("tasks:assign") ? <p className="readonly-note">Read-only scope: task assignment controls are not available for your role.</p> : null}
        </article>

        <article className="card" style={{ overflowX: "auto" }}>
          <h3>Equipment State</h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>Equipment</th><th style={th}>Heartbeat</th><th style={th}>Observed</th></tr></thead>
            <tbody>
              {heartbeats.map((heartbeat) => (
                <tr key={heartbeat.id}>
                  <td style={td}>{heartbeat.equipmentId}</td>
                  <td style={td}>{statusFromHeartbeat(heartbeat)}</td>
                  <td style={td}>{new Date(heartbeat.observedAt).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      </section>
    </main>
  );
}

const th: React.CSSProperties = { textAlign: "left", padding: "0.45rem", borderBottom: "1px solid var(--border)" };
const td: React.CSSProperties = { padding: "0.45rem", borderBottom: "1px solid #eef2f7" };
