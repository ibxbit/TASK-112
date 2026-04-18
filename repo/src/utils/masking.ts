import type { UserRole } from "../db/schema";
import { canViewUnmasked } from "./rbac";

const maskWord = (word: string): string => {
  if (word.length <= 1) {
    return "*";
  }
  return `${word[0]}${"*".repeat(Math.max(1, word.length - 1))}`;
};

export const maskNameForRole = (name: string | null | undefined, role: UserRole | null): string => {
  const normalized = (name ?? "").trim();
  if (!normalized) {
    return "-";
  }
  if (canViewUnmasked(role)) {
    return normalized;
  }
  return normalized
    .split(/\s+/)
    .map(maskWord)
    .join(" ");
};

export const maskBadgeIdForRole = (badgeId: string | null | undefined, role: UserRole | null): string => {
  const normalized = (badgeId ?? "").trim();
  if (!normalized) {
    return "-";
  }
  if (canViewUnmasked(role)) {
    return normalized;
  }
  const visible = normalized.slice(-2);
  return `${"*".repeat(Math.max(3, normalized.length - 2))}${visible}`;
};
