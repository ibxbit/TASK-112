import { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { logout } from "./store/authSlice";
import { store, type AppDispatch, type RootState, uiActions } from "./store";
import QueueBoard from "./pages/QueueBoard";
import EquipmentPanel from "./pages/EquipmentPanel";
import Calendar from "./pages/Calendar";
import MeetingWorkspace from "./pages/MeetingWorkspace";
import NotificationCenter from "./pages/NotificationCenter";
import RoleGate from "./components/RoleGate";
import Forbidden from "./pages/Forbidden";
import PasswordReset from "./pages/PasswordReset";
import AdminConsole from "./pages/AdminConsole";
import AuditorTrail from "./pages/AuditorTrail";
import DispatcherDashboard from "./pages/DispatcherDashboard";
import type { UserRole } from "./db/schema";
import { maskNameForRole } from "./utils/masking";
import { roleHomeRoute } from "./utils/rbac";
import { useServiceOrchestration } from "./hooks/useServiceOrchestration";
import { dal } from "./db/dal";
import ToastViewport from "./components/ToastViewport";
import { usePermissions } from "./hooks/usePermissions";
import type { Permission } from "./config/permissions";
import { eventBus } from "./services/EventBus";
import { sessionManager } from "./utils/SessionManager";
import { loginLocalUser, registerLocalUser } from "./store/authThunks";
import { authService } from "./services/AuthService";

const PBKDF2_ITERATIONS = 120000;
const DEFAULT_ADMIN_USERNAME = "administrator";
const MIN_BOOTSTRAP_PASSWORD_LENGTH = 12;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let output = "";
  for (let i = 0; i < bytes.length; i += 1) {
    output += String.fromCharCode(bytes[i]);
  }
  return btoa(output);
};

const derivePasswordHash = async (password: string, salt: Uint8Array): Promise<string> => {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: salt as BufferSource,
    },
    keyMaterial,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
};

const hasBootstrapPasswordStrength = (password: string): boolean => {
  const trimmed = password.trim();
  if (trimmed.length < MIN_BOOTSTRAP_PASSWORD_LENGTH) {
    return false;
  }
  const hasUpper = /[A-Z]/.test(trimmed);
  const hasLower = /[a-z]/.test(trimmed);
  const hasDigit = /\d/.test(trimmed);
  return hasUpper && hasLower && hasDigit;
};

const useIdleAutoLock = (): void => {
  useEffect(() => {
    sessionManager.init(store);
    return () => {
      sessionManager.dispose();
    };
  }, []);
};

const RoutePersistence = (): null => {
  const location = useLocation();
  const dispatch = useDispatch<AppDispatch>();

  useEffect(() => {
    dispatch(uiActions.setLastSite(location.pathname));
  }, [dispatch, location.pathname]);

  return null;
};

const LoginPage = (): JSX.Element => {
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const auth = useSelector((state: RootState) => state.auth);
  const uiError = useSelector((state: RootState) => state.ui.globalError);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [requiresAdminSetup, setRequiresAdminSetup] = useState(false);
  const [seedPassword, setSeedPassword] = useState("");
  const [seedConfirmPassword, setSeedConfirmPassword] = useState("");
  const error = auth.error ?? uiError;

  useEffect(() => {
    void (async () => {
      try {
        const adminAvailable = await authService.ensureUsernameAvailable(DEFAULT_ADMIN_USERNAME);
        setRequiresAdminSetup(adminAvailable);
      } catch {
        setRequiresAdminSetup(false);
      }
    })();
  }, []);

  const onRegister = async (): Promise<void> => {
    await dispatch(registerLocalUser({ username, displayName, temporaryPassword: password }));
  };

  const onSetupAdmin = async (): Promise<void> => {
    if (!seedPassword || seedPassword !== seedConfirmPassword) {
      dispatch(uiActions.enqueueToast({
        variant: "warning",
        durationMs: 5000,
        message: "Administrator setup requires matching password fields.",
      }));
      return;
    }
    if (!hasBootstrapPasswordStrength(seedPassword)) {
      dispatch(uiActions.enqueueToast({
        variant: "warning",
        durationMs: 6000,
        message: "Administrator password must be at least 12 characters with uppercase, lowercase, and a number.",
      }));
      return;
    }
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const temporaryPasswordHash = await derivePasswordHash(seedPassword, salt);
      await dal.ensureAdminSeed({
        username: DEFAULT_ADMIN_USERNAME,
        displayName: "System Administrator",
        temporaryPasswordHash,
        salt: bytesToBase64(salt),
        iterations: PBKDF2_ITERATIONS,
      });
      setSeedPassword("");
      setSeedConfirmPassword("");
      setRequiresAdminSetup(false);
      dispatch(uiActions.enqueueToast({
        variant: "success",
        durationMs: 3000,
        message: "Administrator account initialized. Sign in with username administrator.",
      }));
    } catch {
      dispatch(uiActions.enqueueToast({
        variant: "error",
        durationMs: 5000,
        message: "Administrator setup failed. Retry initialization.",
      }));
    }
  };

  const onLogin = async (): Promise<void> => {
    const action = await dispatch(loginLocalUser({ username, password }));
    if (loginLocalUser.fulfilled.match(action)) {
      if (action.payload.mustResetPassword) {
        navigate("/reset-password", { replace: true });
        return;
      }
      const destination = store.getState().auth.lastSite;
      const roleHome = roleHomeRoute[action.payload.role] ?? "/queue";
      navigate(destination !== "/login" ? destination : roleHome, { replace: true });
    }
  };

  return (
    <section className="auth-page">
      <form className="auth-card" onSubmit={(event) => event.preventDefault()}>
        {requiresAdminSetup ? (
          <>
            <h1>Initialize Administrator</h1>
            <p className="auth-caption">Create the one-time administrator credential before user sign-in is enabled.</p>
            <label>
              Administrator Password
              <input type="password" value={seedPassword} onChange={(e) => setSeedPassword(e.target.value)} />
            </label>
            <label>
              Confirm Administrator Password
              <input type="password" value={seedConfirmPassword} onChange={(e) => setSeedConfirmPassword(e.target.value)} />
            </label>
            <div className="auth-actions">
              <button type="button" onClick={() => void onSetupAdmin()}>
                Initialize Admin
              </button>
            </div>
            {error ? (
              <p className="inline-error">
                {error.code}: {error.message}
              </p>
            ) : null}
          </>
        ) : (
          <>
        <h1>WOGC Control Login</h1>
        <p className="auth-caption">Simple Modern interface for queue, calendar, equipment, meetings, and notifications.</p>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Display Name (for register)
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          Password / Temporary Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <div className="auth-actions">
        <button type="button" onClick={onLogin} disabled={auth.status === "loading"}>
          Login
        </button>
        <button type="button" onClick={onRegister} disabled={auth.status === "loading"}>
          Register
        </button>
        </div>
        {error ? (
          <p className="inline-error">
          {error.code}: {error.message}
          </p>
        ) : null}
          </>
        )}
      </form>
    </section>
  );
};

const AuthGate = ({ children }: { children: JSX.Element }): JSX.Element => {
  const isAuthenticated = useSelector((state: RootState) => state.auth.isAuthenticated);
  const mustResetPassword = useSelector((state: RootState) => state.auth.mustResetPassword);
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  if (mustResetPassword) {
    return <Navigate to="/reset-password" replace />;
  }
  return children;
};

const GuestGate = ({ children }: { children: JSX.Element }): JSX.Element => {
  const isAuthenticated = useSelector((state: RootState) => state.auth.isAuthenticated);
  const mustResetPassword = useSelector((state: RootState) => state.auth.mustResetPassword);
  const lastSite = useSelector((state: RootState) => state.auth.lastSite);
  if (isAuthenticated) {
    if (mustResetPassword) {
      return <Navigate to="/reset-password" replace />;
    }
    const destination = lastSite !== "/login" ? lastSite : "/queue";
    return <Navigate to={destination} replace />;
  }
  return children;
};

const navItems: Array<{ to: string; label: string; permission: Permission }> = [
  { to: "/dispatcher", label: "Dispatcher", permission: "dispatcher_dashboard:read" },
  { to: "/queue", label: "Queue Board", permission: "tasks:read" },
  { to: "/equipment", label: "Equipment", permission: "equipment:read" },
  { to: "/calendar", label: "Calendar", permission: "calendar:read" },
  { to: "/meetings", label: "Meetings", permission: "meetings:read" },
  { to: "/notifications", label: "Notifications", permission: "notifications:read" },
  { to: "/auditor", label: "Auditor Trail", permission: "audit:read" },
  { to: "/admin", label: "Admin Console", permission: "admin:read" },
];

const AuthLayout = (): JSX.Element => {
  const dispatch = useDispatch<AppDispatch>();
  const auth = useSelector((state: RootState) => state.auth);
  const { can } = usePermissions();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const visibleName = maskNameForRole(auth.displayName ?? auth.username, auth.role);

  const allowedNavItems = navItems.filter((item) => can(item.permission));

  useEffect(() => {
    if (!auth.isAuthenticated) {
      return;
    }
    void eventBus.hydrateDLQView();
  }, [auth.isAuthenticated, auth.role]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const loadUnread = async (): Promise<void> => {
      if (!auth.userId) {
        setUnreadCount(0);
        return;
      }
      try {
        const count = await dal.unreadNotificationCount(auth.userId);
        setUnreadCount(count);
      } catch {
        setUnreadCount(0);
      }
    };
    void loadUnread();
    timer = setInterval(() => {
      void loadUnread();
    }, 2500);
    return () => {
      if (timer) {
        clearInterval(timer);
      }
    };
  }, [auth.userId]);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <header className="sidebar-header">
          <h2>WOGC</h2>
          <button type="button" className="ghost" onClick={() => setSidebarOpen(false)}>
            Close
          </button>
        </header>
        <p className="sidebar-user">
          {visibleName} ({auth.role})
        </p>
        <nav className="sidebar-nav">
          {allowedNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
              onClick={() => setSidebarOpen(false)}
            >
              {item.label}{item.to === "/notifications" ? ` (${unreadCount})` : ""}
            </NavLink>
          ))}
        </nav>
        <button type="button" className="danger" onClick={() => dispatch(logout())}>
          Logout
        </button>
      </aside>

      <section className="app-content">
        <header className="mobile-topbar">
          <button type="button" onClick={() => setSidebarOpen((value) => !value)}>
            Menu
          </button>
          <strong>Warehouse Console</strong>
        </header>
        <Outlet />
      </section>
    </div>
  );
};

const HomeRedirect = (): JSX.Element => {
  const role = useSelector((state: RootState) => state.auth.role as UserRole | null);
  if (!role) {
    return <Navigate to="/login" replace />;
  }
  return <Navigate to={roleHomeRoute[role]} replace />;
};

const AppShell = (): JSX.Element => {
  const isAuthenticated = useSelector((state: RootState) => state.auth.isAuthenticated);
  const role = useSelector((state: RootState) => state.auth.role);
  useServiceOrchestration(isAuthenticated, role);
  useIdleAutoLock();

  return (
    <>
      <RoutePersistence />
      <ToastViewport />
      <Routes>
        <Route
          path="/login"
          element={
            <GuestGate>
              <LoginPage />
            </GuestGate>
          }
        />
        <Route path="/forbidden" element={<Forbidden />} />
        <Route path="/reset-password" element={<PasswordReset />} />
        <Route
          path="/"
          element={
            <AuthGate>
              <AuthLayout />
            </AuthGate>
          }
        >
          <Route index element={<HomeRedirect />} />
          <Route path="queue" element={<RoleGate permission="tasks:read"><QueueBoard /></RoleGate>} />
          <Route path="dispatcher" element={<RoleGate permission="dispatcher_dashboard:read"><DispatcherDashboard /></RoleGate>} />
          <Route path="equipment" element={<RoleGate permission="equipment:read"><EquipmentPanel /></RoleGate>} />
          <Route path="calendar" element={<RoleGate permission="calendar:read"><Calendar /></RoleGate>} />
          <Route path="meetings" element={<RoleGate permission="meetings:read"><MeetingWorkspace /></RoleGate>} />
          <Route path="notifications" element={<RoleGate permission="notifications:read"><NotificationCenter /></RoleGate>} />
          <Route path="notification-settings" element={<RoleGate permission="notifications:manage_settings"><Navigate to="/notifications?tab=settings" replace /></RoleGate>} />
          <Route path="delivery-logs" element={<RoleGate permission="notifications:delivery_logs"><Navigate to="/notifications?tab=delivery-logs" replace /></RoleGate>} />
          <Route path="admin" element={<RoleGate permission="admin:read"><AdminConsole /></RoleGate>} />
          <Route path="auditor" element={<RoleGate permission="audit:read"><AuditorTrail /></RoleGate>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
};

export default function App(): JSX.Element {
  return <AppShell />;
}
