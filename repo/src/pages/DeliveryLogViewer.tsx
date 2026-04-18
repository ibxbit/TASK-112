import { type CSSProperties, useEffect, useState } from "react";
import { dal } from "../db/dal";
import { WOGCError } from "../utils/errors";

export default function DeliveryLogViewer(): JSX.Element {
  const [userId, setUserId] = useState("");
  const [eventType, setEventType] = useState("");
  const [fromISO, setFromISO] = useState("");
  const [toISO, setToISO] = useState("");
  const [rows, setRows] = useState<Array<{ id: number; userId: number; eventType: string; deliveredAt: string; status: "delivered" | "suppressed_quiet_hours"; suppressedReason?: string; read: boolean; readAt?: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const data = await dal.listDeliveryLogs({
        userId: userId ? Number(userId) : undefined,
        eventType: eventType || undefined,
        fromISO: fromISO || undefined,
        toISO: toISO || undefined,
      });
      setRows(data);
      setError(null);
    } catch (caught) {
      if (caught instanceof WOGCError) {
        setError(`${caught.code}: ${caught.message}`);
      }
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <main style={{ padding: "1rem", display: "grid", gap: "0.75rem" }}>
      <h2>Notification Delivery Logs</h2>
      {error ? <p className="inline-error">{error}</p> : null}

      <section className="row-wrap">
        <input value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="User ID" />
        <input value={eventType} onChange={(event) => setEventType(event.target.value)} placeholder="Event type" />
        <input type="datetime-local" value={fromISO} onChange={(event) => setFromISO(event.target.value)} />
        <input type="datetime-local" value={toISO} onChange={(event) => setToISO(event.target.value)} />
        <button type="button" onClick={() => void load()}>Apply</button>
      </section>

      <section style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "12px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr><th style={th}>User</th><th style={th}>Event</th><th style={th}>Delivered</th><th style={th}>Status</th><th style={th}>Reason</th><th style={th}>Read</th><th style={th}>Read At</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td style={td}>{row.userId}</td>
                <td style={td}>{row.eventType}</td>
                <td style={td}>{new Date(row.deliveredAt).toLocaleString()}</td>
                <td style={td}>{row.status}</td>
                <td style={td}>{row.suppressedReason ?? "-"}</td>
                <td style={td}>{row.read ? "yes" : "no"}</td>
                <td style={td}>{row.readAt ? new Date(row.readAt).toLocaleString() : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

const th: CSSProperties = { textAlign: "left", padding: "0.45rem", borderBottom: "1px solid var(--border)" };
const td: CSSProperties = { padding: "0.45rem", borderBottom: "1px solid #eef2f7" };
