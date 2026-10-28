import type { ErrorCode } from "@nexus/contracts";

/** Thrown by handlers; the app error handler renders it as an ApiError body. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: unknown;
  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = "Resource") => new HttpError(404, "NOT_FOUND", `${what} not found`);
export const invalidTransition = (from: string, to: string) =>
  new HttpError(409, "INVALID_TRANSITION", `Cannot move job from ${from} to ${to}`, { from, to });
