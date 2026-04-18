import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useSelector } from "react-redux";
import { dal } from "../db/dal";
import type { MeetingAttachmentRecord, MeetingRecord } from "../db/schema";
import { WOGCError } from "../utils/errors";
import { maskBadgeIdForRole, maskNameForRole } from "../utils/masking";
import type { RootState } from "../store";
import Can from "../components/Can";
import { useToast } from "../hooks/useToast";
import { exportEncryptedBackup } from "../utils/backupExport";

type MeetingRow = MeetingRecord & { id: number };
type AttachmentRow = MeetingAttachmentRecord & { id: number };

const mapMeetingError = (error: WOGCError): string => {
  if (error.code === "AUTH_403") {
    return "Meeting workspace action blocked by role policy.";
  }
  if (error.code === "DB_WRITE_FAIL") {
    return "Meeting changes were not persisted.";
  }
  if (error.code === "DB_READ_FAIL") {
    return "Meeting history could not be loaded.";
  }
  return `${error.code}: ${error.message}`;
};

export default function MeetingWorkspace(): JSX.Element {
  const role = useSelector((state: RootState) => state.auth.role);
  const toast = useToast();
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [activeMeetingId, setActiveMeetingId] = useState<number | null>(null);
  const [agendaItems, setAgendaItems] = useState<Array<{ id: number; title: string; owner?: string; durationMinutes: number; status: "pending" | "in_progress" | "completed"; orderIndex: number; spentMinutes?: number }>>([]);
  const [resolutions, setResolutions] = useState<Array<{ id: number; description: string; proposer: string; owner?: string; dueDate?: string; approved: boolean; voteOutcome?: "approved" | "rejected" | "abstained" }>>([]);
  const [agendaDraft, setAgendaDraft] = useState({ title: "", description: "", owner: "", durationMinutes: 10 });
  const [resolutionDraft, setResolutionDraft] = useState({ description: "", proposer: "", owner: "", dueDate: "", approved: false as boolean, voteOutcome: "approved" as "approved" | "rejected" | "abstained" });
  const [subject, setSubject] = useState("");
  const [facilitator, setFacilitator] = useState("");
  const [minutes, setMinutes] = useState("");
  const [attendeeInput, setAttendeeInput] = useState("");
  const [attendees, setAttendees] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [badgeByUsername, setBadgeByUsername] = useState<Record<string, string>>({});
  const [storedAttachments, setStoredAttachments] = useState<AttachmentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupStatus, setBackupStatus] = useState<{ kind: "idle" | "loading" | "success" | "error"; message?: string }>({ kind: "idle" });

  const attachmentSummaries = useMemo(
    () => attachments.map((file) => `${file.name} (${Math.ceil(file.size / 1024)}KB)`),
    [attachments],
  );

  const loadMeetings = async (): Promise<void> => {
    try {
      const rows = await dal.listMeetings();
      setMeetings(rows);
      if (!activeMeetingId && rows.length > 0) {
        setActiveMeetingId(rows[0].id);
      }
    } catch (error) {
      if (error instanceof WOGCError) {
        toast.error(mapMeetingError(error));
      }
    }
  };

  useEffect(() => {
    void loadMeetings();
  }, []);

  const addAttendee = (): void => {
    const value = attendeeInput.trim();
    if (!value) {
      return;
    }
    setAttendees((prev) => [...prev, value]);
    void dal.getUserProfileByUsername(value).then((user) => {
      if (user?.badgeId) {
        setBadgeByUsername((prev) => ({ ...prev, [value]: user.badgeId }));
      }
    }).catch(() => undefined);
    setAttendeeInput("");
  };

  const onFileChange = (files: FileList | null): void => {
    if (!files) {
      return;
    }
    const accepted = Array.from(files).filter((file) =>
      ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(file.type),
    );
    if (accepted.length !== files.length) {
      toast.error("Invalid attachment type rejected. Only PDF and DOCX are allowed.");
    }
    setAttachments(accepted);
  };

  const saveMeeting = async (): Promise<void> => {
    try {
      const start = new Date();
      const end = new Date(Date.now() + 30 * 60 * 1000);
      await dal.saveMeeting({
        subject,
        facilitator,
        minutes,
        signIn: attendees,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      });
      toast.success("Meeting record saved.");
      await loadMeetings();
    } catch (error) {
      if (error instanceof WOGCError) {
        toast.error(mapMeetingError(error));
      }
    }
  };

  const spawnTaskFromMinutes = async (): Promise<void> => {
    try {
      const parsed = parseActionItems(minutes);
      if (parsed.length === 0) {
        toast.info("No action markers found (ACTION:/TODO:/[ ]).");
        return;
      }
      for (const item of parsed) {
        await dal.saveTask({
          title: `Meeting Action: ${item.description.slice(0, 80)}`,
          status: "open",
          workstream: "transport",
          priority: 2,
          assignee: item.assignee || facilitator,
          dueDate: item.dueDate,
          createdAt: new Date().toISOString(),
        });
      }
      toast.success(`Spawned ${parsed.length} task(s) from structured minutes.`);
    } catch (error) {
      if (error instanceof WOGCError) {
        toast.error(mapMeetingError(error));
      }
    }
  };

  const loadGovernance = async (): Promise<void> => {
    if (!activeMeetingId) {
      return;
    }
    try {
      const [agenda, resolutionRows, attachmentRows] = await Promise.all([
        dal.listAgendaItems(activeMeetingId),
        dal.listResolutions(activeMeetingId),
        dal.listAttachments(activeMeetingId),
      ]);
      setAgendaItems(agenda);
      setResolutions(resolutionRows);
      setStoredAttachments(attachmentRows);
    } catch (error) {
      if (error instanceof WOGCError) {
        toast.error(mapMeetingError(error));
      }
    }
  };

  useEffect(() => {
    void loadGovernance();
  }, [activeMeetingId]);

  const saveAgenda = async (): Promise<void> => {
    if (!activeMeetingId) {
      toast.warning("Save a meeting first to manage agenda.");
      return;
    }
    await dal.saveAgendaItem({
      meetingId: activeMeetingId,
      title: agendaDraft.title,
      description: agendaDraft.description,
      owner: agendaDraft.owner,
      durationMinutes: agendaDraft.durationMinutes,
      orderIndex: agendaItems.length,
      status: "pending",
      spentMinutes: 0,
    });
    setAgendaDraft({ title: "", description: "", owner: "", durationMinutes: 10 });
    await loadGovernance();
  };

  const updateAgendaStatus = async (id: number, status: "pending" | "in_progress" | "completed"): Promise<void> => {
    const row = agendaItems.find((item) => item.id === id);
    if (!row || !activeMeetingId) {
      return;
    }
    await dal.saveAgendaItem({
      id,
      meetingId: activeMeetingId,
      title: row.title,
      description: "",
      owner: row.owner,
      durationMinutes: row.durationMinutes,
      orderIndex: row.orderIndex,
      status,
      spentMinutes: row.spentMinutes,
    });
    await loadGovernance();
  };

  const saveResolution = async (): Promise<void> => {
    if (!activeMeetingId) {
      toast.warning("Save a meeting first to add resolutions.");
      return;
    }
    await dal.saveResolution({
      meetingId: activeMeetingId,
      description: resolutionDraft.description,
      proposer: resolutionDraft.proposer,
      owner: resolutionDraft.owner,
      dueDate: resolutionDraft.dueDate,
      approved: resolutionDraft.approved,
      voteOutcome: resolutionDraft.voteOutcome,
    });
    setResolutionDraft({ description: "", proposer: "", owner: "", dueDate: "", approved: false, voteOutcome: "approved" });
    await loadGovernance();
  };

  const saveAttachments = async (): Promise<void> => {
    if (!activeMeetingId) {
      toast.warning("Save a meeting first to upload attachments.");
      return;
    }
    try {
      setBusy(true);
      for (const file of attachments) {
        const hash = await fileHash(file);
        await dal.saveAttachment({
          meetingId: activeMeetingId,
          filename: file.name,
          size: file.size,
          uploader: facilitator,
          mimeType: file.type as "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          contentHash: hash,
          blobData: file,
        });
      }
      setAttachments([]);
      await loadGovernance();
      toast.success("Attachments stored and available for distribution.");
    } catch (error) {
      if (error instanceof WOGCError) {
        toast.error(mapMeetingError(error));
      }
    } finally {
      setBusy(false);
    }
  };

  const downloadAttachment = async (attachmentId: number): Promise<void> => {
    try {
      const payload = await dal.getAttachmentBlob(attachmentId);
      if (!payload) {
        toast.warning("Attachment payload is unavailable.");
        return;
      }
      const url = URL.createObjectURL(payload.blobData);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = payload.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.info(`Downloaded ${payload.filename}.`);
    } catch (error) {
      toast.fromError(error, "Attachment download failed.");
    }
  };

  const distributeMaterials = async (): Promise<void> => {
    if (!activeMeetingId) {
      toast.warning("Select a meeting before distributing materials.");
      return;
    }
    const activeMeeting = meetings.find((meeting) => meeting.id === activeMeetingId);
    const attendeesForDistribution = activeMeeting?.signIn?.length ? activeMeeting.signIn : attendees;
    const attachmentCount = storedAttachments.length;
    if (attachmentCount === 0) {
      toast.warning("No stored attachments to distribute.");
      return;
    }
    try {
      setBusy(true);
      const recipientIds = await dal.resolveUserIdsByUsernames(attendeesForDistribution);
      if (recipientIds.length === 0) {
        toast.warning("No attendee usernames matched registered users.");
        return;
      }
      for (const recipientId of recipientIds) {
        const notificationId = await dal.saveNotification({
          userId: recipientId,
          category: "meeting_reminder",
          level: "info",
          eventType: "meeting.materials.distributed",
          message: `Meeting materials available (${attachmentCount} file(s)). Open Meeting Workspace to download attachments for meeting ${activeMeetingId}.`,
        });
        await dal.saveDeliveryLog({
          notificationId,
          userId: recipientId,
          eventType: "meeting.materials.distributed",
          status: "delivered",
        });
      }
      toast.success(`Distributed materials to ${recipientIds.length} attendee(s).`);
    } catch (error) {
      toast.fromError(error, "Failed to distribute meeting materials.");
    } finally {
      setBusy(false);
    }
  };

  const exportBackupNow = async (): Promise<void> => {
    try {
      setBackupStatus({ kind: "loading", message: "Exporting encrypted backup..." });
      const filename = await exportEncryptedBackup(backupPassphrase);
      setBackupStatus({ kind: "success", message: `Backup exported: ${filename}` });
      toast.success(`Encrypted backup exported as ${filename}.`);
    } catch (error) {
      if (error instanceof WOGCError) {
        setBackupStatus({ kind: "error", message: `${error.code}: ${error.message}` });
      } else {
        setBackupStatus({ kind: "error", message: "Backup export failed." });
      }
      toast.fromError(error, "Encrypted backup export failed.");
    }
  };

  return (
    <main style={{ padding: "1rem", display: "grid", gap: "0.75rem" }}>
      <h2 style={{ margin: 0 }}>Meeting Workspace</h2>

      <Can permission="meetings:manage" fallback={<p className="readonly-note">Read-only scope: meeting creation and governance controls are not available for your role.</p>}>
      <section style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Live Session</h3>
        <div style={grid2}>
          <label style={labelStyle}>
            Subject
            <input value={subject} onChange={(event) => setSubject(event.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Facilitator
            <input value={facilitator} onChange={(event) => setFacilitator(event.target.value)} style={inputStyle} />
          </label>
        </div>

        <label style={labelStyle}>
          Minutes
          <textarea
            rows={6}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            placeholder="Capture decisions, blockers, and actions"
            style={inputStyle}
          />
        </label>

        <div style={grid2}>
          <div>
            <p style={{ margin: "0 0 0.35rem 0", fontWeight: 600 }}>Sign-In</p>
            <div style={{ display: "flex", gap: "0.45rem" }}>
              <input value={attendeeInput} onChange={(event) => setAttendeeInput(event.target.value)} style={inputStyle} />
              <button type="button" onClick={addAttendee}>
                Add
              </button>
            </div>
            <p style={{ margin: "0.35rem 0 0 0" }}>
              {attendees.map((name) => `${maskNameForRole(name, role)} [${maskBadgeIdForRole(badgeByUsername[name], role)}]`).join(", ") || "No attendees yet"}
            </p>
          </div>

          <div>
            <p style={{ margin: "0 0 0.35rem 0", fontWeight: 600 }}>Attachments (local Blob files)</p>
            <input type="file" multiple onChange={(event) => onFileChange(event.target.files)} />
            <ul style={{ margin: "0.35rem 0 0 1rem", padding: 0 }}>
              {attachmentSummaries.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>

        <div style={{ display: "flex", gap: "0.45rem", marginTop: "0.7rem" }}>
          <button type="button" onClick={() => void saveMeeting()}>
            Save Meeting
          </button>
          <button type="button" onClick={() => void spawnTaskFromMinutes()}>
            Spawn Task
          </button>
          <button type="button" onClick={() => void saveAttachments()} disabled={busy}>
            Save Attachments
          </button>
          <button type="button" onClick={() => void distributeMaterials()} disabled={busy}>
            Distribute Materials
          </button>
        </div>
      </section>
      </Can>

      <section style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Stored Attachments</h3>
        {storedAttachments.length === 0 ? <p style={{ margin: 0 }}>No attachment payloads saved for this meeting.</p> : null}
        <ul style={{ margin: 0, paddingLeft: "1rem" }}>
          {storedAttachments.map((attachment) => (
            <li key={attachment.id}>
              {attachment.filename} ({Math.ceil(attachment.size / 1024)}KB)
              <button type="button" onClick={() => void downloadAttachment(attachment.id)} style={{ marginLeft: "0.45rem" }}>
                Download
              </button>
            </li>
          ))}
        </ul>
      </section>

      <Can permission="meetings:manage" fallback={null}>
      <section style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Agenda Management</h3>
        <div style={grid2}>
          <input placeholder="Agenda title" value={agendaDraft.title} onChange={(event) => setAgendaDraft((prev) => ({ ...prev, title: event.target.value }))} style={inputStyle} />
          <input placeholder="Owner" value={agendaDraft.owner} onChange={(event) => setAgendaDraft((prev) => ({ ...prev, owner: event.target.value }))} style={inputStyle} />
          <input type="number" min={1} value={agendaDraft.durationMinutes} onChange={(event) => setAgendaDraft((prev) => ({ ...prev, durationMinutes: Number(event.target.value) || 10 }))} style={inputStyle} />
          <button type="button" onClick={() => void saveAgenda()}>Add Agenda Item</button>
        </div>
        <ul>
          {agendaItems.map((item) => (
            <li key={item.id}>
              #{item.orderIndex + 1} {item.title} ({item.durationMinutes}m) - {item.status}
              <button type="button" onClick={() => void updateAgendaStatus(item.id, "in_progress")}>Start</button>
              <button type="button" onClick={() => void updateAgendaStatus(item.id, "completed")}>Complete</button>
            </li>
          ))}
        </ul>
      </section>
      </Can>

      <Can permission="meetings:manage" fallback={null}>
      <section style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Resolution Tracking</h3>
        <div style={grid2}>
          <input placeholder="Resolution description" value={resolutionDraft.description} onChange={(event) => setResolutionDraft((prev) => ({ ...prev, description: event.target.value }))} style={inputStyle} />
          <input placeholder="Proposer" value={resolutionDraft.proposer} onChange={(event) => setResolutionDraft((prev) => ({ ...prev, proposer: event.target.value }))} style={inputStyle} />
          <input placeholder="Owner" value={resolutionDraft.owner} onChange={(event) => setResolutionDraft((prev) => ({ ...prev, owner: event.target.value }))} style={inputStyle} />
          <input type="date" value={resolutionDraft.dueDate} onChange={(event) => setResolutionDraft((prev) => ({ ...prev, dueDate: event.target.value }))} style={inputStyle} />
          <select value={resolutionDraft.voteOutcome} onChange={(event) => setResolutionDraft((prev) => ({ ...prev, voteOutcome: event.target.value as "approved" | "rejected" | "abstained" }))} style={inputStyle}>
            <option value="approved">approved</option>
            <option value="rejected">rejected</option>
            <option value="abstained">abstained</option>
          </select>
          <label><input type="checkbox" checked={resolutionDraft.approved} onChange={(event) => setResolutionDraft((prev) => ({ ...prev, approved: event.target.checked }))} /> Approved (spawns task)</label>
          <button type="button" onClick={() => void saveResolution()}>Save Resolution</button>
        </div>
        <ul>
          {resolutions.map((resolution) => (
            <li key={resolution.id}>{resolution.description} | proposer: {maskNameForRole(resolution.proposer, role)} | owner: {maskNameForRole(resolution.owner, role)} | vote: {resolution.voteOutcome}</li>
          ))}
        </ul>
      </section>
      </Can>

      <section style={{ ...cardStyle, overflowX: "auto" }}>
        <h3 style={{ marginTop: 0 }}>Recent Meetings</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Subject</th>
              <th style={th}>Facilitator</th>
              <th style={th}>Signed In</th>
              <th style={th}>Started</th>
            </tr>
          </thead>
          <tbody>
            {meetings.map((meeting) => (
              <tr key={meeting.id}>
                <td style={td}>{meeting.subject}</td>
                <td style={td}>{maskNameForRole(meeting.facilitator ?? "-", role)}</td>
                <td style={td}>{meeting.signIn?.length ?? 0}</td>
                <td style={td}>{new Date(meeting.startAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <Can permission="admin:read" fallback={null}>
      <section style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Encrypted Backup Export</h3>
        <p style={{ margin: "0 0 0.5rem 0", color: "#475569" }}>
          Export all IndexedDB data to encrypted JSON blob using PBKDF2 + AES-GCM.
        </p>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <input
            type="password"
            placeholder="Backup passphrase"
            value={backupPassphrase}
            onChange={(event) => setBackupPassphrase(event.target.value)}
            style={{ ...inputStyle, minWidth: "20rem" }}
          />
          <button type="button" onClick={() => void exportBackupNow()} disabled={backupStatus.kind === "loading"}>
            Export Encrypted JSON
          </button>
        </div>
        {backupStatus.kind !== "idle" ? (
          <p
            style={{
              margin: "0.5rem 0 0 0",
              color: backupStatus.kind === "error" ? "#b42318" : backupStatus.kind === "success" ? "#067647" : "#0f172a",
            }}
          >
            {backupStatus.message}
          </p>
        ) : null}
      </section>
      </Can>
    </main>
  );
}

const cardStyle: CSSProperties = {
  border: "1px solid #d5d9df",
  borderRadius: "0.5rem",
  padding: "0.75rem",
  background: "#fdfdfd",
};

const grid2: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
  gap: "0.65rem",
};

const labelStyle: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
};

const inputStyle: CSSProperties = {
  border: "1px solid #aeb5bf",
  borderRadius: "0.4rem",
  padding: "0.45rem",
  font: "inherit",
};

const th: CSSProperties = {
  textAlign: "left",
  padding: "0.4rem",
  borderBottom: "1px solid #dce2ea",
};

const td: CSSProperties = {
  padding: "0.4rem",
  borderBottom: "1px solid #eff2f7",
};

type ParsedAction = {
  description: string;
  assignee?: string;
  dueDate?: string;
};

const parseActionItems = (minutes: string): ParsedAction[] => {
  const lines = minutes.split("\n").map((line) => line.trim());
  const markers = ["ACTION:", "TODO:", "[ ]"];
  const actions: ParsedAction[] = [];
  for (const line of lines) {
    const marker = markers.find((item) => line.toUpperCase().startsWith(item));
    if (!marker) {
      continue;
    }
    const body = marker === "[ ]" ? line.slice(3).trim() : line.slice(marker.length).trim();
    const assigneeMatch = body.match(/@([a-zA-Z0-9._-]+)/);
    const dueMatch = body.match(/due\s*[:=]\s*(\d{4}-\d{2}-\d{2})/i);
    const description = body
      .replace(/@([a-zA-Z0-9._-]+)/g, "")
      .replace(/due\s*[:=]\s*\d{4}-\d{2}-\d{2}/gi, "")
      .trim();
    actions.push({
      description,
      assignee: assigneeMatch?.[1],
      dueDate: dueMatch?.[1],
    });
  }
  return actions;
};

const fileHash = async (file: File): Promise<string> => {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
