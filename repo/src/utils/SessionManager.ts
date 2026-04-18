import type { store as storeType } from "../store";
import { idleLock, logout } from "../store/authSlice";

type AppStore = typeof storeType;

declare global {
  interface Window {
    __WOGC_SESSION_MANAGER__?: SessionManager;
  }
}

const CHANNEL_NAME = "wogc-session";
const STORAGE_ACTIVITY_KEY = "wogc_session_last_activity";
const STORAGE_LOGOUT_KEY = "wogc_session_logout";
const THROTTLE_MS = 1000;
const HEARTBEAT_MS = 1000;

class SessionManager {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private activityListener: ((event: Event) => void) | null = null;
  private store: AppStore | null = null;
  private lastActivityTimestamp = Date.now();
  private lastEmitTimestamp = 0;
  private channel: BroadcastChannel | null = null;
  private storageListener: ((event: StorageEvent) => void) | null = null;

  public init(store: AppStore): void {
    this.store = store;
    this.lastActivityTimestamp = Date.now();
    this.attachCrossTabSync();
    this.attachActivityListeners();
    this.startHeartbeat();
    const shouldExposeForTests = typeof window !== "undefined" && "__wogcTest" in (window as unknown as Record<string, unknown>);
    if ((typeof import.meta !== "undefined" && import.meta.env.MODE !== "production") || shouldExposeForTests) {
      window.__WOGC_SESSION_MANAGER__ = this;
    }
  }

  public dispose(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.activityListener) {
      const events: Array<keyof WindowEventMap> = ["mousemove", "keydown", "click", "scroll", "touchstart"];
      for (const eventName of events) {
        window.removeEventListener(eventName, this.activityListener);
      }
      this.activityListener = null;
    }
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    if (this.storageListener) {
      window.removeEventListener("storage", this.storageListener);
      this.storageListener = null;
    }
    const shouldExposeForTests = typeof window !== "undefined" && "__wogcTest" in (window as unknown as Record<string, unknown>);
    if ((typeof import.meta !== "undefined" && import.meta.env.MODE !== "production") || shouldExposeForTests) {
      delete window.__WOGC_SESSION_MANAGER__;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      this.tickHeartbeat();
    }, HEARTBEAT_MS);
  }

  public tickHeartbeat(): void {
    this.tickHeartbeatImpl();
  }

  public forceSetLastActivity(timestamp: number): void {
    this.lastActivityTimestamp = timestamp;
  }

  private tickHeartbeatImpl(): void {
    const appStore = this.store;
    if (!appStore) {
      return;
    }
    const state = appStore.getState();
    if (!state.auth.isAuthenticated) {
      return;
    }
    const sessionTimeoutMs = state.auth.sessionTimeoutMs;
    if (Date.now() - this.lastActivityTimestamp > sessionTimeoutMs) {
      appStore.dispatch(idleLock());
      this.broadcastLogout();
    }
  }

  private attachActivityListeners(): void {
    if (this.activityListener) {
      return;
    }
    this.activityListener = () => {
      const now = Date.now();
      if (now - this.lastEmitTimestamp < THROTTLE_MS) {
        return;
      }
      this.lastEmitTimestamp = now;
      this.lastActivityTimestamp = now;
      this.broadcastPing(now);
    };
    const events: Array<keyof WindowEventMap> = ["mousemove", "keydown", "click", "scroll", "touchstart"];
    for (const eventName of events) {
      window.addEventListener(eventName, this.activityListener);
    }
  }

  private attachCrossTabSync(): void {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (message: MessageEvent<{ type: "ping" | "logout"; timestamp: number }>) => {
        if (message.data.type === "ping") {
          this.lastActivityTimestamp = Math.max(this.lastActivityTimestamp, message.data.timestamp);
        }
        if (message.data.type === "logout") {
          this.store?.dispatch(logout());
        }
      };
      return;
    }

    this.storageListener = (event: StorageEvent) => {
      if (event.key === STORAGE_ACTIVITY_KEY && event.newValue) {
        const ts = Number.parseInt(event.newValue, 10);
        if (Number.isFinite(ts)) {
          this.lastActivityTimestamp = Math.max(this.lastActivityTimestamp, ts);
        }
      }
      if (event.key === STORAGE_LOGOUT_KEY && event.newValue) {
        this.store?.dispatch(logout());
      }
    };
    window.addEventListener("storage", this.storageListener);
  }

  private broadcastPing(timestamp: number): void {
    if (this.channel) {
      this.channel.postMessage({ type: "ping", timestamp });
      return;
    }
    localStorage.setItem(STORAGE_ACTIVITY_KEY, String(timestamp));
  }

  private broadcastLogout(): void {
    const timestamp = Date.now();
    if (this.channel) {
      this.channel.postMessage({ type: "logout", timestamp });
      return;
    }
    localStorage.setItem(STORAGE_LOGOUT_KEY, String(timestamp));
  }
}

export const sessionManager = new SessionManager();
