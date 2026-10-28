export type Log = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

// One JSON line per entry on stderr. Never put tokens or request headers in fields.
export const log: Log = (level, msg, fields) =>
  console.error(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
