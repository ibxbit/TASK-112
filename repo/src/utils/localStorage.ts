const memoryStore = new Map<string, string>();

export type ThemePreference = "light" | "dark";

export type BootLocalStorageConfig = {
  theme: ThemePreference;
  lastSite: string;
  sessionTimeoutMs: number;
};

const DEFAULT_SESSION_TIMEOUT_MS = 15 * 60 * 1000;

const browserStorage = (): Storage | null => {
  if (typeof window === "undefined") {
    return null;
  }
  if (!window.localStorage) {
    return null;
  }
  return window.localStorage;
};

const getRaw = (key: string): string | null => {
  const storage = browserStorage();
  if (storage) {
    return storage.getItem(key);
  }
  return memoryStore.get(key) ?? null;
};

const setRaw = (key: string, value: string): void => {
  const storage = browserStorage();
  if (storage) {
    storage.setItem(key, value);
    return;
  }
  memoryStore.set(key, value);
};

const parseTheme = (value: string | null): ThemePreference => {
  if (value === "dark") {
    return "dark";
  }
  return "light";
};

const parseLastSite = (value: string | null): string => {
  if (!value) {
    return "/";
  }
  if (!value.startsWith("/")) {
    return "/";
  }
  return value;
};

const parseSessionTimeoutMs = (value: string | null): number => {
  if (!value) {
    return DEFAULT_SESSION_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SESSION_TIMEOUT_MS;
  }
  return parsed;
};

export const readBootLocalStorageConfig = (): BootLocalStorageConfig => {
  const theme = parseTheme(getRaw("theme"));
  const lastSite = parseLastSite(getRaw("lastSite") ?? getRaw("last_site"));
  const sessionTimeoutMs = parseSessionTimeoutMs(getRaw("sessionTimeout"));
  return {
    theme,
    lastSite,
    sessionTimeoutMs,
  };
};

export const setThemePreference = (theme: ThemePreference): void => {
  setRaw("theme", theme);
};

export const setLastSitePreference = (path: string): void => {
  setRaw("last_site", parseLastSite(path));
};

export const setSessionTimeoutPreference = (timeoutMs: number): void => {
  const normalized = timeoutMs > 0 ? Math.trunc(timeoutMs) : DEFAULT_SESSION_TIMEOUT_MS;
  setRaw("sessionTimeout", String(normalized));
};
