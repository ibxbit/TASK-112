import { describe, expect, it } from "vitest";
import { WOGCError, ensureWOGCError } from "../src/utils/errors";

describe("WOGCError contract", () => {
  it("preserves strict contract fields", () => {
    const error = new WOGCError({
      code: "AUTH_403",
      message: "Unauthorized",
      context: { table: "tasks" },
      retryable: false,
    });

    expect(error.code).toBe("AUTH_403");
    expect(error.message).toBe("Unauthorized");
    expect(error.context).toEqual({ table: "tasks" });
    expect(error.retryable).toBe(false);
    expect(error.toJSON()).toEqual({
      code: "AUTH_403",
      message: "Unauthorized",
      context: { table: "tasks" },
      retryable: false,
    });
  });

  it("normalizes raw JS errors into WOGCError safely", () => {
    const normalized = ensureWOGCError(new TypeError("x is not a function"), {
      code: "UNEXPECTED",
      message: "Unexpected",
      context: { source: "unit-test" },
      retryable: true,
    });

    expect(normalized).toBeInstanceOf(WOGCError);
    expect(normalized.code).toBe("UNEXPECTED");
    expect(normalized.message).toContain("x is not a function");
    expect(normalized.retryable).toBe(true);
    expect(normalized.context.source).toBe("unit-test");
  });

  it("accepts contract-like objects and rehydrates WOGCError", () => {
    const normalized = ensureWOGCError({
      code: "CRYPTO_ERR",
      message: "Decrypt failed",
      context: { file: "backup.enc.json" },
      retryable: false,
    });

    expect(normalized).toBeInstanceOf(WOGCError);
    expect(normalized.code).toBe("CRYPTO_ERR");
    expect(normalized.context.file).toBe("backup.enc.json");
    expect(normalized.retryable).toBe(false);
  });
});
