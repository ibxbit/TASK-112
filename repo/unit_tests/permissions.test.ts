import { describe, expect, it } from "vitest";
import { hasPermission } from "../src/config/permissions";

describe("permission model", () => {
  it("grants administrator full surfaces", () => {
    expect(hasPermission("administrator", "admin:read")).toBe(true);
    expect(hasPermission("administrator", "audit:verify")).toBe(true);
    expect(hasPermission("administrator", "equipment:command")).toBe(true);
  });

  it("restricts auditor to immutable audit surfaces", () => {
    expect(hasPermission("auditor", "audit:read")).toBe(true);
    expect(hasPermission("auditor", "audit:export")).toBe(true);
    expect(hasPermission("auditor", "tasks:read")).toBe(false);
    expect(hasPermission("auditor", "equipment:read")).toBe(false);
  });

  it("keeps viewer read-only and blocks mutation actions", () => {
    expect(hasPermission("viewer", "tasks:read")).toBe(true);
    expect(hasPermission("viewer", "tasks:create")).toBe(false);
    expect(hasPermission("viewer", "tasks:assign")).toBe(false);
  });
});
