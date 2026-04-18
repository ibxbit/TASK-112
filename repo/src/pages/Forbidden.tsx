import { useLocation, useNavigate } from "react-router-dom";

export default function Forbidden(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const fallback = (location.state as { from?: string } | null)?.from ?? "/queue";

  return (
    <main style={{ padding: "1rem", display: "grid", gap: "0.8rem" }}>
      <h2>Forbidden</h2>
      <p>You do not have permission to access this area.</p>
      <button type="button" onClick={() => navigate(fallback, { replace: true })}>
        Go to allowed workspace
      </button>
    </main>
  );
}
