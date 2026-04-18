import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { dal } from "../db/dal";
import type { EquipmentHeartbeatRecord } from "../db/schema";
import { WOGCError } from "../utils/errors";
import Can from "../components/Can";
import { useToast } from "../hooks/useToast";

type HeartbeatRow = EquipmentHeartbeatRecord & { id: number };

const mapPanelError = (error: WOGCError): string => {
  if (error.code === "AUTH_403") {
    return "You are not authorized to operate equipment controls.";
  }
  if (error.code === "DB_READ_FAIL") {
    return "Heartbeat feed unavailable. IndexedDB read failed.";
  }
  if (error.code === "DB_WRITE_FAIL") {
    return "Command queue write failed. Request not sent.";
  }
  return `${error.code}: ${error.message}`;
};

const ageColor = (ageMs: number): string => {
  return ageMs < 20_000 ? "#1f8d4a" : "#b21f1f";
};

export default function EquipmentPanel(): JSX.Element {
  const toast = useToast();
  const [heartbeats, setHeartbeats] = useState<HeartbeatRow[]>([]);
  const [equipmentId, setEquipmentId] = useState("");
  const [command, setCommand] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorState, setErrorState] = useState<string | null>(null);
  const [successState, setSuccessState] = useState<string | null>(null);

  const latestByEquipment = useMemo(() => {
    const map = new Map<string, HeartbeatRow>();
    for (const row of heartbeats) {
      const current = map.get(row.equipmentId);
      if (!current || Date.parse(current.observedAt) < Date.parse(row.observedAt)) {
        map.set(row.equipmentId, row);
      }
    }
    return Array.from(map.values()).sort((a, b) => a.equipmentId.localeCompare(b.equipmentId));
  }, [heartbeats]);

  const loadHeartbeats = async (): Promise<void> => {
    setLoading(true);
    try {
      const rows = await dal.listHeartbeats(120);
      setHeartbeats(rows);
      setErrorState(null);
    } catch (error) {
      if (error instanceof WOGCError) {
        const message = mapPanelError(error);
        toast.fromError(error, message);
        setErrorState(message);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadHeartbeats();
    const timer = setInterval(() => {
      void loadHeartbeats();
    }, 2_500);
    return () => clearInterval(timer);
  }, []);

  const queueCommand = async (): Promise<void> => {
    if (!equipmentId.trim() || !command.trim()) {
      toast.warning("Enter equipment id and command before queueing.");
      return;
    }
    try {
      const id = await dal.enqueueEquipmentCommand({
        topic: "equipment.command",
        equipmentId: equipmentId.trim(),
        command: command.trim(),
        args: { source: "equipment_panel" },
        actingRole: "dispatcher",
      });
      const message = `Command queued as #${id} for ${equipmentId.trim()}.`;
      toast.success(message);
      setSuccessState(message);
      setErrorState(null);
    } catch (error) {
      if (error instanceof WOGCError) {
        const message = mapPanelError(error);
        toast.fromError(error, message);
        setErrorState(message);
        setSuccessState(null);
      } else {
        toast.error("Unexpected command failure.");
        setErrorState("Unexpected command failure.");
        setSuccessState(null);
      }
    }
  };

  const timeoutCount = latestByEquipment.filter((row) => Date.now() - Date.parse(row.observedAt) >= 20_000).length;

  return (
    <main style={{ padding: "1rem", display: "grid", gap: "0.8rem" }}>
      <h2 style={{ margin: 0 }}>Equipment Panel</h2>
      {loading ? <p className="readonly-note">Loading heartbeat telemetry...</p> : null}
      {successState ? <p className="readonly-note" style={{ borderColor: "#75e0a7", background: "#ecfdf3" }}>{successState}</p> : null}
      {errorState ? <p className="inline-error">{errorState}</p> : null}
      {timeoutCount > 0 ? <p className="inline-error">Timeout Alert: {timeoutCount} equipment endpoint(s) have heartbeat age above 20 seconds.</p> : null}

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))", gap: "0.6rem" }}>
        {latestByEquipment.map((row) => {
          const ageMs = Date.now() - Date.parse(row.observedAt);
          const color = ageColor(ageMs);
          return (
            <article key={row.id} style={{ border: `2px solid ${color}`, borderRadius: "0.5rem", padding: "0.6rem", background: "#fbfbfb" }}>
              <h3 style={{ margin: "0 0 0.25rem 0" }}>{row.equipmentId}</h3>
              <p style={{ margin: 0, color }}>Heartbeat age: {Math.floor(ageMs / 1000)}s</p>
              <p style={{ margin: "0.2rem 0 0 0" }}>Status: {row.status}</p>
              <p style={{ margin: "0.2rem 0 0 0" }}>Latency: {row.latencyMs}ms</p>
            </article>
          );
        })}
      </section>

      <Can permission="equipment:command" fallback={<p className="readonly-note">Read-only scope: equipment command controls are unavailable.</p>}>
        <section style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
          <input value={equipmentId} onChange={(event) => setEquipmentId(event.target.value)} style={inputStyle} />
          <input value={command} onChange={(event) => setCommand(event.target.value)} style={inputStyle} />
          <button type="button" onClick={() => void queueCommand()}>
            Queue Command
          </button>
        </section>
      </Can>
    </main>
  );
}

const inputStyle: CSSProperties = {
  border: "1px solid #b5ad9d",
  borderRadius: "0.4rem",
  padding: "0.45rem",
};
