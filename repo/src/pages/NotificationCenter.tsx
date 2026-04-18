import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useSelector } from "react-redux";
import { useLocation, useNavigate } from "react-router-dom";
import ExportModal from "../components/ExportModal";
import { dal } from "../db/dal";
import type { NotificationDeliveryLogRecord, NotificationRecord } from "../db/schema";
import type { RootState } from "../store";
import { usePermissions } from "../hooks/usePermissions";
import { useToast } from "../hooks/useToast";
import { maskBadgeIdForRole, maskNameForRole } from "../utils/masking";

type NotificationRow = NotificationRecord & { id: number };
type DeliveryLogRow = NotificationDeliveryLogRecord & { id: number };
type Tab = "inbox" | "settings" | "delivery-logs";

const categories: NotificationRecord["category"][] = ["task_assignment", "equipment_alert", "meeting_reminder", "system"];

export default function NotificationCenter(): JSX.Element {
  const userId = useSelector((state: RootState) => state.auth.userId);
  const role = useSelector((state: RootState) => state.auth.role);
  const { can } = usePermissions();
  const toast = useToast();
  const location = useLocation();
  const navigate = useNavigate();

  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [deliveryRows, setDeliveryRows] = useState<DeliveryLogRow[]>([]);
  const [levelFilter, setLevelFilter] = useState<"all" | "info" | "warn" | "error">("all");
  const [categoryFilter, setCategoryFilter] = useState<"all" | NotificationRecord["category"]>("all");
  const [search, setSearch] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [recipientByUserId, setRecipientByUserId] = useState<Record<number, { username: string; badgeId: string }>>({});
  const [loading, setLoading] = useState(false);

  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [quietStart, setQuietStart] = useState("");
  const [quietEnd, setQuietEnd] = useState("");

  const [logUserId, setLogUserId] = useState("");
  const [logEventType, setLogEventType] = useState("");
  const [logFromISO, setLogFromISO] = useState("");
  const [logToISO, setLogToISO] = useState("");

  const canManageSettings = can("notifications:manage_settings");
  const canViewDeliveryLogs = can("notifications:delivery_logs");
  const requestedTab = (new URLSearchParams(location.search).get("tab") ?? "inbox") as Tab;
  const activeTab: Tab =
    requestedTab === "settings" && canManageSettings
      ? "settings"
      : requestedTab === "delivery-logs" && canViewDeliveryLogs
        ? "delivery-logs"
        : "inbox";

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      const level = row.level ?? "info";
      if (levelFilter !== "all" && level !== levelFilter) {
        return false;
      }
      if (categoryFilter !== "all" && row.category !== categoryFilter) {
        return false;
      }
      if (!needle) {
        return true;
      }
      return row.message.toLowerCase().includes(needle) || (row.eventType ?? "").toLowerCase().includes(needle);
    });
  }, [categoryFilter, levelFilter, rows, search]);

  const setTab = (tab: Tab): void => {
    navigate({ pathname: "/notifications", search: tab === "inbox" ? "" : `?tab=${tab}` }, { replace: true });
  };

  const loadInbox = async (): Promise<void> => {
    if (!userId) {
      return;
    }
    try {
      const [items, unreadCount] = await Promise.all([dal.listNotifications(500, userId), dal.unreadNotificationCount(userId)]);
      setRows(items);
      setUnread(unreadCount);
      const lookup = await Promise.all(items.map(async (row) => {
        const user = await dal.getUserProfile(row.userId);
        if (!user) {
          return [row.userId, { username: `user-${row.userId}`, badgeId: "" }] as const;
        }
        return [row.userId, { username: user.username, badgeId: user.badgeId }] as const;
      }));
      setRecipientByUserId(Object.fromEntries(lookup));
    } catch (error) {
      toast.fromError(error, "Failed to load notifications.");
    }
  };

  const loadSettings = async (): Promise<void> => {
    if (!userId || !canManageSettings) {
      return;
    }
    try {
      const rows = await dal.listSubscriptions(userId);
      const next: Record<string, boolean> = {};
      for (const category of categories) {
        const found = rows.find((row) => row.category === category);
        next[category] = found ? found.enabled : true;
      }
      setPrefs(next);
      const first = rows[0];
      setQuietStart(first?.quietHoursStart ?? "");
      setQuietEnd(first?.quietHoursEnd ?? "");
    } catch (error) {
      toast.fromError(error, "Failed to load notification settings.");
    }
  };

  const loadDeliveryLogs = async (): Promise<void> => {
    if (!canViewDeliveryLogs) {
      return;
    }
    try {
      const data = await dal.listDeliveryLogs({
        userId: logUserId ? Number(logUserId) : undefined,
        eventType: logEventType || undefined,
        fromISO: logFromISO || undefined,
        toISO: logToISO || undefined,
      });
      setDeliveryRows(data);
    } catch (error) {
      toast.fromError(error, "Failed to load delivery logs.");
    }
  };

  useEffect(() => {
    setLoading(true);
    void Promise.all([loadInbox(), loadSettings(), loadDeliveryLogs()]).finally(() => setLoading(false));
    const timer = setInterval(() => {
      void loadInbox();
    }, 2500);
    return () => clearInterval(timer);
  }, [userId, canManageSettings, canViewDeliveryLogs]);

  const markRead = async (notificationId: number): Promise<void> => {
    if (!userId) {
      return;
    }
    try {
      setLoading(true);
      await dal.markNotificationRead(notificationId, userId);
      await Promise.all([loadInbox(), loadDeliveryLogs()]);
      toast.success("Notification marked as read.");
    } catch (error) {
      toast.fromError(error, "Failed to mark notification as read.");
    } finally {
      setLoading(false);
    }
  };

  const togglePreference = async (category: NotificationRecord["category"], enabled: boolean): Promise<void> => {
    if (!userId) {
      return;
    }
    try {
      setLoading(true);
      await dal.upsertSubscription({ userId, category, enabled });
      setPrefs((prev) => ({ ...prev, [category]: enabled }));
      toast.success(`Notification preference updated for ${category}.`);
    } catch (error) {
      toast.fromError(error, "Failed to update notification preference.");
    } finally {
      setLoading(false);
    }
  };

  const saveQuietHours = async (): Promise<void> => {
    if (!userId) {
      return;
    }
    try {
      setLoading(true);
      await dal.setUserQuietHours(userId, quietStart || undefined, quietEnd || undefined);
      toast.success("Quiet hours saved.");
      await loadSettings();
    } catch (error) {
      toast.fromError(error, "Failed to save quiet hours.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ padding: "1rem", display: "grid", gap: "0.75rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Notification Center</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <span style={badgeStyle}>Unread: {unread}</span>
          <button type="button" onClick={() => setExportOpen(true)}>
            Encrypted Backup
          </button>
        </div>
      </header>

      <section style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button type="button" onClick={() => setTab("inbox")} disabled={activeTab === "inbox"}>Inbox</button>
        {canManageSettings ? <button type="button" onClick={() => setTab("settings")} disabled={activeTab === "settings"}>Settings</button> : null}
        {canViewDeliveryLogs ? <button type="button" onClick={() => setTab("delivery-logs")} disabled={activeTab === "delivery-logs"}>Delivery Logs</button> : null}
      </section>

      {activeTab === "inbox" ? (
        <>
          <section style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value as typeof levelFilter)} style={inputStyle}>
              <option value="all">All Levels</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
            </select>
            <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as typeof categoryFilter)} style={inputStyle}>
              <option value="all">All Categories</option>
              <option value="task_assignment">Task Assignment</option>
              <option value="equipment_alert">Equipment Alert</option>
              <option value="meeting_reminder">Meeting Reminder</option>
              <option value="system">System</option>
            </select>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search message/event" style={inputStyle} />
          </section>

          <section style={{ border: "1px solid #ced5de", borderRadius: "0.45rem", overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead style={{ background: "#edf2f9" }}>
                <tr>
                  <th style={th}>Time</th>
                  <th style={th}>Channel</th>
                  <th style={th}>Level</th>
                  <th style={th}>Category</th>
                  <th style={th}>Event</th>
                  <th style={th}>Message</th>
                  <th style={th}>Recipient</th>
                  <th style={th}>Read</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.id} style={{ background: "#ffffff" }}>
                    <td style={td}>{new Date(row.createdAt).toLocaleString()}</td>
                    <td style={td}>In-App</td>
                    <td style={td}>{row.level ?? "info"}</td>
                    <td style={td}>{row.category}</td>
                    <td style={td}>{row.eventType ?? "manual"}</td>
                    <td style={{ ...td, fontWeight: row.level === "error" ? 700 : 500 }}>{row.message}</td>
                    <td style={td}>{`${maskNameForRole(recipientByUserId[row.userId]?.username ?? `user-${row.userId}`, role)} [${maskBadgeIdForRole(recipientByUserId[row.userId]?.badgeId, role)}]`}</td>
                    <td style={td}>{can("notifications:mark_read") ? <button type="button" onClick={() => void markRead(row.id)} disabled={loading}>Mark Read</button> : "Read-only"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {!can("notifications:mark_read") ? <p className="readonly-note">Read-only scope: you can view notifications but cannot mutate read state.</p> : null}
        </>
      ) : null}

      {activeTab === "settings" ? (
        <section className="card">
          {categories.map((category) => (
            <label key={category} style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
              <span>{category}</span>
              <input
                type="checkbox"
                checked={prefs[category] ?? true}
                disabled={loading}
                onChange={(event) => void togglePreference(category, event.target.checked)}
              />
            </label>
          ))}

          <div style={{ marginTop: "0.6rem", display: "grid", gap: "0.5rem" }}>
            <strong>Quiet hours</strong>
            <div className="row-wrap" style={{ marginBottom: 0 }}>
              <label>
                Start
                <input type="time" value={quietStart} onChange={(event) => setQuietStart(event.target.value)} disabled={loading} />
              </label>
              <label>
                End
                <input type="time" value={quietEnd} onChange={(event) => setQuietEnd(event.target.value)} disabled={loading} />
              </label>
              <button type="button" onClick={() => void saveQuietHours()} disabled={loading}>Save Quiet Hours</button>
            </div>
            <p style={{ margin: 0, color: "#475569" }}>Notifications are suppressed during quiet hours and logged in delivery history.</p>
          </div>
        </section>
      ) : null}

      {activeTab === "delivery-logs" ? (
        <>
          <section className="row-wrap">
            <input value={logUserId} onChange={(event) => setLogUserId(event.target.value)} placeholder="User ID" />
            <input value={logEventType} onChange={(event) => setLogEventType(event.target.value)} placeholder="Event type" />
            <input type="datetime-local" value={logFromISO} onChange={(event) => setLogFromISO(event.target.value)} />
            <input type="datetime-local" value={logToISO} onChange={(event) => setLogToISO(event.target.value)} />
            <button type="button" onClick={() => void loadDeliveryLogs()}>Apply</button>
          </section>

          <section style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "12px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr><th style={th}>User</th><th style={th}>Event</th><th style={th}>Delivered</th><th style={th}>Status</th><th style={th}>Reason</th><th style={th}>Read</th><th style={th}>Read At</th></tr>
              </thead>
              <tbody>
                {deliveryRows.map((row) => (
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
        </>
      ) : null}

      {loading ? <p className="readonly-note">Loading notifications...</p> : null}

      <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
    </main>
  );
}

const inputStyle: CSSProperties = {
  border: "1px solid #aab4c1",
  borderRadius: "0.4rem",
  padding: "0.45rem",
};

const badgeStyle: CSSProperties = {
  background: "#e0e7ff",
  color: "#312e81",
  border: "1px solid #c7d2fe",
  borderRadius: "999px",
  padding: "0.2rem 0.6rem",
  fontSize: "0.8rem",
  fontWeight: 700,
};

const th: CSSProperties = {
  textAlign: "left",
  padding: "0.45rem",
  borderBottom: "1px solid #dbe2eb",
};

const td: CSSProperties = {
  padding: "0.45rem",
  borderBottom: "1px solid #eef2f7",
  verticalAlign: "top",
};
