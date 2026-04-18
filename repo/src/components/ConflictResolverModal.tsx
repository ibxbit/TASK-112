import { type CSSProperties, useMemo, useState } from "react";
import { conflictService } from "../services/ConflictService";
import { WOGCError } from "../utils/errors";

export type QueueConflict = {
  taskId: number;
  taskTitle: string;
  resourceId: string;
  assignee?: string;
};

type ConflictModalProps = {
  open: boolean;
  conflicts: QueueConflict[];
  onClose: () => void;
  onResolved: () => Promise<void>;
};

const mapInlineMessage = (error: WOGCError): string => {
  if (error.code === "VAL_REASON_REQUIRED") {
    return "Please provide a concrete resolution reason (minimum 8 characters).";
  }
  if (error.code === "TASK_404") {
    return "The selected task no longer exists. Refresh queue data and retry.";
  }
  if (error.code === "AUTH_403") {
    return "Your role cannot resolve resource conflicts.";
  }
  return error.message;
};

export default function ConflictResolverModal({ open, conflicts, onClose, onResolved }: ConflictModalProps): JSX.Element | null {
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [keepResource, setKeepResource] = useState(true);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const selectedTask = useMemo(
    () => conflicts.find((item) => item.taskId === selectedTaskId) ?? conflicts[0],
    [conflicts, selectedTaskId],
  );

  if (!open) {
    return null;
  }

  const submitResolution = async (): Promise<void> => {
    setSubmitting(true);
    setInlineError(null);
    const target = selectedTask;
    if (!target) {
      setInlineError("No conflict selected.");
      setSubmitting(false);
      return;
    }

    try {
      await conflictService.resolve({
        taskId: target.taskId,
        keepResource,
        reason,
      });
      setReason("");
      await onResolved();
      onClose();
    } catch (error) {
      if (error instanceof WOGCError) {
        setInlineError(mapInlineMessage(error));
      } else {
        setInlineError("Conflict submission failed unexpectedly.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Resolve Queue Conflict">
      <section style={modalStyle}>
        <h3 style={{ marginTop: 0 }}>Conflict Resolver</h3>
        <p style={{ marginTop: 0, color: "#4d4d4d" }}>Double-assigned resources detected. Select task and force reasoned resolution.</p>

        <label style={labelStyle}>
          Conflicted Task
          <select
            value={selectedTask?.taskId ?? ""}
            onChange={(event) => setSelectedTaskId(Number(event.target.value))}
            style={inputStyle}
          >
            {conflicts.map((conflict) => (
              <option key={conflict.taskId} value={conflict.taskId}>
                {conflict.taskTitle} | {conflict.resourceId}
              </option>
            ))}
          </select>
        </label>

        <label style={labelStyle}>
          Resolution Reason
          <textarea
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Describe why this resource assignment is valid"
            style={textareaStyle}
          />
        </label>

        <div style={{ display: "flex", gap: "0.75rem", marginBottom: "0.75rem" }}>
          <label style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
            <input type="radio" checked={keepResource} onChange={() => setKeepResource(true)} />
            Keep resource assignment
          </label>
          <label style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
            <input type="radio" checked={!keepResource} onChange={() => setKeepResource(false)} />
            Remove from selected task
          </label>
        </div>

        {inlineError ? <p style={{ color: "#ab1f1f", marginTop: 0 }}>{inlineError}</p> : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="button" onClick={() => void submitResolution()} disabled={submitting}>
            Resolve
          </button>
        </div>
      </section>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(17, 27, 36, 0.35)",
  display: "grid",
  placeItems: "center",
  zIndex: 40,
};

const modalStyle: CSSProperties = {
  width: "min(40rem, 94vw)",
  background: "#fffef9",
  border: "1px solid #ded9c7",
  borderRadius: "0.75rem",
  padding: "1rem",
  boxShadow: "0 12px 24px rgba(0, 0, 0, 0.12)",
};

const labelStyle: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
  fontWeight: 600,
  marginBottom: "0.75rem",
};

const inputStyle: CSSProperties = {
  border: "1px solid #aaa391",
  borderRadius: "0.45rem",
  padding: "0.5rem",
  font: "inherit",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  resize: "vertical",
};
