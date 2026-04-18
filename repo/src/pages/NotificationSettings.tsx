import { useEffect, useState } from "react";
import { useSelector } from "react-redux";
import { dal } from "../db/dal";
import type { NotificationRecord } from "../db/schema";
import type { RootState } from "../store";
import { useToast } from "../hooks/useToast";

const categories: NotificationRecord["category"][] = ["task_assignment", "equipment_alert", "meeting_reminder", "system"];

export default function NotificationSettings(): JSX.Element {
  const userId = useSelector((state: RootState) => state.auth.userId);
  const toast = useToast();
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [quietStart, setQuietStart] = useState("");
  const [quietEnd, setQuietEnd] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async (): Promise<void> => {
    if (!userId) {
      return;
    }
    try {
      setLoading(true);
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
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [userId]);

  const toggle = async (category: NotificationRecord["category"], enabled: boolean): Promise<void> => {
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
      await load();
    } catch (error) {
      toast.fromError(error, "Failed to save quiet hours.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ padding: "1rem", display: "grid", gap: "0.75rem" }}>
      <h2>Notification Settings</h2>
      <section className="card">
        {categories.map((category) => (
          <label key={category} style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
            <span>{category}</span>
            <input
              type="checkbox"
              checked={prefs[category] ?? true}
              disabled={loading}
              onChange={(event) => void toggle(category, event.target.checked)}
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
    </main>
  );
}
