import { useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Navigate } from "react-router-dom";
import { resetPasswordAfterFirstLogin } from "../store/authThunks";
import type { AppDispatch, RootState } from "../store";

export default function PasswordReset(): JSX.Element {
  const dispatch = useDispatch<AppDispatch>();
  const auth = useSelector((state: RootState) => state.auth);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  if (!auth.isAuthenticated || !auth.userId) {
    return <Navigate to="/login" replace />;
  }
  if (!auth.mustResetPassword) {
    return <Navigate to="/" replace />;
  }

  const submit = async (): Promise<void> => {
    if (nextPassword.length < 10) {
      setLocalError("New password must be at least 10 characters.");
      return;
    }
    if (nextPassword !== confirmPassword) {
      setLocalError("Confirmation password does not match.");
      return;
    }
    setLocalError(null);
    await dispatch(resetPasswordAfterFirstLogin({ userId: auth.userId, currentPassword, nextPassword }));
  };

  return (
    <main className="auth-page">
      <section className="auth-card">
        <h2>Reset Temporary Password</h2>
        <p className="auth-caption">A password update is mandatory before accessing protected features.</p>
        <label>
          Current password
          <input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        </label>
        <label>
          New password
          <input type="password" value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} />
        </label>
        <label>
          Confirm new password
          <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
        </label>
        <button type="button" onClick={() => void submit()}>
          Update password
        </button>
        {localError ? <p className="inline-error">{localError}</p> : null}
        {auth.error ? <p className="inline-error">{auth.error.code}: {auth.error.message}</p> : null}
      </section>
    </main>
  );
}
