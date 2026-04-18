import { useEffect, useState } from "react";
import { dal } from "../db/dal";
import type { AuditLogRecord } from "../db/schema";
import { WOGCError } from "../utils/errors";
import { usePermissions } from "../hooks/usePermissions";
import { useToast } from "../hooks/useToast";
import { eventBus } from "../services/EventBus";
import type { WOGCEventEnvelope } from "../types/events";
import type { RootState } from "../store";
import { useSelector } from "react-redux";
import { maskBadgeIdForRole, maskNameForRole } from "../utils/masking";

type AuditRow = AuditLogRecord & { id: number };
type DLQRow = {
  id: number;
  eventPayload: WOGCEventEnvelope;
  errorContract: { code: string; message: string; context?: Record<string, unknown>; retryable: boolean };
  failedAt: string;
  retryCount: number;
  status: "pending" | "replayed" | "archived";
};

export default function AuditorTrail(): JSX.Element {
  const { can } = usePermissions();
  const toast = useToast();
  const authRole = useSelector((state: RootState) => state.auth.role);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [entity, setEntity] = useState("");
  const [actor, setActor] = useState("");
  const [fromISO, setFromISO] = useState("");
  const [toISO, setToISO] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dlqRows, setDLQRows] = useState<DLQRow[]>([]);
  const [badgeByUsername, setBadgeByUsername] = useState<Record<string, string>>({});
  const isAuditor = authRole === "auditor";

  const load = async (): Promise<void> => {
    try {
      const data = await dal.listAuditTrail({
        entity: entity || undefined,
        actorUsername: actor || undefined,
        fromISO: fromISO || undefined,
        toISO: toISO || undefined,
      });
      setRows(data);
      const usernames = Array.from(new Set(data.map((row) => row.actorUsername).filter((value): value is string => Boolean(value))));
      const badges = await Promise.all(usernames.map(async (username) => {
        const user = await dal.getUserProfileByUsername(username);
        return [username, user?.badgeId ?? ""] as const;
      }));
      setBadgeByUsername(Object.fromEntries(badges));
      const dlq = await dal.listDLQEntries();
      setDLQRows(dlq);
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

  const retryDLQ = async (id: number): Promise<void> => {
    try {
      await eventBus.retryDLQEvent(id);
      toast.success(`Replayed DLQ event ${id}.`);
      await load();
    } catch (caught) {
      if (caught instanceof WOGCError) {
        toast.error(`${caught.code}: ${caught.message}`);
        return;
      }
      toast.error("DLQ replay failed.");
    }
  };

  const archiveDLQ = async (id: number): Promise<void> => {
    try {
      await eventBus.archiveDLQEvent(id);
      toast.info(`Archived DLQ event ${id}.`);
      await load();
    } catch (caught) {
      if (caught instanceof WOGCError) {
        toast.error(`${caught.code}: ${caught.message}`);
        return;
      }
      toast.error("DLQ archive failed.");
    }
  };

  const verifyChain = (): void => {
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index].sequence >= rows[index - 1].sequence) {
        toast.warning("Audit sequence order check detected non-descending rows. Refresh and retry verification.");
        return;
      }
    }
    toast.success("Audit sequence ordering verification passed.");
  };

  const exportTrail = (): void => {
    const payload = JSON.stringify(rows, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `audit-trail-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.info("Audit trail export downloaded.");
  };

  return (
    <main style={{ padding: "1rem", display: "grid", gap: "0.75rem" }}>
      <h2>Auditor Trail Viewer</h2>
      <p style={{ margin: 0 }}>Immutable append-only audit records with chain hash and sequence.</p>
      {error ? <p className="inline-error">{error}</p> : null}

      <section className="row-wrap">
        <input placeholder="Entity (tasks/users/...)" value={entity} onChange={(event) => setEntity(event.target.value)} />
        <input placeholder="Actor username" value={actor} onChange={(event) => setActor(event.target.value)} />
        <input type="datetime-local" value={fromISO} onChange={(event) => setFromISO(event.target.value)} />
        <input type="datetime-local" value={toISO} onChange={(event) => setToISO(event.target.value)} />
        <button type="button" onClick={() => void load()}>Apply Filters</button>
        {can("audit:verify") ? <button type="button" onClick={verifyChain}>Verify Sequence</button> : null}
        {can("audit:export") ? <button type="button" onClick={exportTrail}>Export JSON</button> : null}
      </section>

      <section style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "12px", background: "var(--surface)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Seq</th><th style={th}>Time</th><th style={th}>Actor</th><th style={th}>Action</th><th style={th}>Entity</th><th style={th}>Hash</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td style={td}>{row.sequence}</td>
                <td style={td}>{new Date(row.timestamp).toLocaleString()}</td>
                <td style={td}>
                  {maskNameForRole(row.actorUsername ?? "anonymous", authRole)}
                  {row.actorUsername ? ` [${maskBadgeIdForRole(badgeByUsername[row.actorUsername], authRole)}]` : ""}
                  {` (${row.actorRole})`}
                </td>
                <td style={td}>{row.action}</td>
                <td style={td}>{row.entity}#{row.entityId}</td>
                <td style={{ ...td, fontFamily: "ui-monospace, Menlo, monospace" }}>{row.hash.slice(0, 16)}...</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "12px", background: "var(--surface)" }}>
        <h3 style={{ margin: "0.75rem" }}>Persisted Dead Letter Queue</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>ID</th><th style={th}>Event</th><th style={th}>Error</th><th style={th}>Failed</th><th style={th}>Retries</th><th style={th}>Status</th><th style={th}>Action</th>
            </tr>
          </thead>
          <tbody>
            {dlqRows.map((row) => (
              <tr key={row.id}>
                <td style={td}>{row.id}</td>
                <td style={td}>{row.eventPayload.type}</td>
                <td style={td}>{row.errorContract.code}</td>
                <td style={td}>{new Date(row.failedAt).toLocaleString()}</td>
                <td style={td}>{row.retryCount}</td>
                <td style={td}>{row.status}</td>
                <td style={td}>
                  {isAuditor ? (
                    <span style={{ opacity: 0.6 }}>Read-only</span>
                  ) : (
                    <>
                      <button type="button" onClick={() => void retryDLQ(row.id)} disabled={row.status !== "pending"}>Retry</button>
                      <button type="button" onClick={() => void archiveDLQ(row.id)} style={{ marginLeft: "0.4rem" }}>Archive</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

const th: React.CSSProperties = { textAlign: "left", padding: "0.45rem", borderBottom: "1px solid var(--border)" };
const td: React.CSSProperties = { padding: "0.45rem", borderBottom: "1px solid #eef2f7" };
