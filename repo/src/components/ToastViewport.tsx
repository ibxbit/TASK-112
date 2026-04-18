import { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { AppDispatch, RootState, ToastMessage } from "../store";
import { uiActions } from "../store";

export default function ToastViewport(): JSX.Element {
  const dispatch = useDispatch<AppDispatch>();
  const toasts = useSelector((state: RootState) => state.ui.toasts as ToastMessage[]);

  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = toasts.map((toast: ToastMessage) => {
      return setTimeout(() => {
        dispatch(uiActions.dismissToast(toast.id));
      }, toast.durationMs);
    });
    return () => {
      timers.forEach((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
    };
  }, [dispatch, toasts]);

  return (
    <section className="toast-viewport" aria-label="Notifications">
      {toasts.map((toast: ToastMessage) => (
        <article
          key={toast.id}
          className={`toast toast-${toast.variant}`}
          role={toast.variant === "error" || toast.variant === "warning" || toast.variant === "permission-error" ? "alert" : "status"}
          aria-live={toast.variant === "error" || toast.variant === "warning" || toast.variant === "permission-error" ? "assertive" : "polite"}
        >
          <p>{toast.message}</p>
          <div className="toast-actions">
            {toast.undo ? (
              <button
                type="button"
                onClick={() => {
                  const undo = toast.undo;
                  if (!undo) {
                    return;
                  }
                  dispatch({ type: undo.actionType, payload: undo.payload });
                  dispatch(uiActions.dismissToast(toast.id));
                }}
              >
                {toast.undo.label}
              </button>
            ) : null}
            <button type="button" className="toast-close" onClick={() => dispatch(uiActions.dismissToast(toast.id))} aria-label="Dismiss notification">
              X
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
