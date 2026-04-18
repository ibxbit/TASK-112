export type WOGCErrorContext = Record<string, unknown>;

export type WOGCErrorInput = {
  code: string;
  message: string;
  context?: WOGCErrorContext;
  retryable: boolean;
};

export class WOGCError extends Error {
  public readonly code: string;
  public readonly context: WOGCErrorContext;
  public readonly retryable: boolean;

  public constructor({ code, message, context = {}, retryable }: WOGCErrorInput) {
    super(message);
    this.name = "WOGCError";
    this.code = code;
    this.context = context;
    this.retryable = retryable;
  }

  public toJSON(): WOGCErrorInput {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
      retryable: this.retryable,
    };
  }
}

export const isWOGCError = (value: unknown): value is WOGCError => {
  return value instanceof WOGCError;
};

export const ensureWOGCError = (
  value: unknown,
  fallback: WOGCErrorInput = {
    code: "UNEXPECTED",
    message: "An unexpected error occurred",
    context: {},
    retryable: true,
  },
): WOGCError => {
  if (value instanceof WOGCError) {
    return value;
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    "retryable" in value
  ) {
    const err = value as Partial<WOGCErrorInput>;
    if (typeof err.code === "string" && typeof err.message === "string" && typeof err.retryable === "boolean") {
      return new WOGCError({
        code: err.code,
        message: err.message,
        context: err.context ?? {},
        retryable: err.retryable,
      });
    }
  }

  if (value instanceof Error) {
    return new WOGCError({
      code: fallback.code,
      message: value.message || fallback.message,
      context: { ...fallback.context, stack: value.stack },
      retryable: fallback.retryable,
    });
  }

  return new WOGCError(fallback);
};
