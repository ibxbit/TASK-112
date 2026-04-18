export type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const envMode = (import.meta.env.MODE ?? "development").toLowerCase();
const configured = (import.meta.env.VITE_LOG_LEVEL as string | undefined)?.toLowerCase() as LogLevel | undefined;
const activeLevel: LogLevel = configured ?? (envMode === "production" ? "warn" : "debug");

const badgeRegex = /\b\d{4}-\d{4}\b/g;
const credentialRegex = /((password|token|secret|credential|apiKey)\s*[:=]\s*)([^\s,;]+)/gi;

const sanitizeText = (value: string): string => value.replace(badgeRegex, "****-****").replace(credentialRegex, "$1[REDACTED]");

const sanitizeMeta = (meta?: Record<string, unknown>): Record<string, unknown> | undefined => {
  if (!meta) {
    return undefined;
  }
  const text = sanitizeText(JSON.stringify(meta));
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { sanitized: text };
  }
};

const shouldLog = (level: LogLevel): boolean => levelOrder[level] >= levelOrder[activeLevel];

const write = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
  if (!shouldLog(level)) {
    return;
  }
  const safeMessage = sanitizeText(message);
  const safeMeta = sanitizeMeta(meta);
  const payload = safeMeta ? `${safeMessage} ${JSON.stringify(safeMeta)}` : safeMessage;
  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  if (level === "info") {
    console.info(payload);
    return;
  }
  console.log(payload);
};

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>): void => write("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>): void => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>): void => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>): void => write("error", message, meta),
};
