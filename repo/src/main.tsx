import React from "react";
import ReactDOM from "react-dom/client";
import AppRoot from "./AppRoot";
import "./styles.css";

const badgeRegex = /\b\d{4}-\d{4}\b/g;
const credentialRegex = /((password|token|secret|credential|apiKey)\s*[:=]\s*)([^\s,;]+)/gi;

const sanitize = (input: unknown): unknown => {
  if (typeof input === "string") {
    return input.replace(badgeRegex, "****-****").replace(credentialRegex, "$1[REDACTED]");
  }
  if (typeof input === "object" && input !== null) {
    try {
      return JSON.parse(JSON.stringify(input).replace(badgeRegex, "****-****").replace(credentialRegex, "$1[REDACTED]"));
    } catch {
      return "[SANITIZED_OBJECT]";
    }
  }
  return input;
};

const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);
console.log = (...args: unknown[]) => {
  originalLog(...args.map((arg) => sanitize(arg)));
};
console.error = (...args: unknown[]) => {
  originalError(...args.map((arg) => sanitize(arg)));
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>,
);
