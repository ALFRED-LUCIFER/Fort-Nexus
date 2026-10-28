import { z } from "zod";

export const ErrorCode = z.enum([
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "INVALID_TRANSITION",
  "STALE_LEASE",
  "IDEMPOTENCY_KEY_REUSED",
  "RUNNER_UNAVAILABLE",
  "RATE_LIMITED",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const Me = z.object({ id: z.string(), email: z.string(), name: z.string() });
export type Me = z.infer<typeof Me>;

export const ApiError = z.object({
  error: z.object({ code: ErrorCode, message: z.string(), details: z.unknown().optional() }),
  requestId: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;
