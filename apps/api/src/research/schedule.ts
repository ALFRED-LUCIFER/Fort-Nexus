import type { BriefSchedule } from "@nexus/contracts";

// Wall-clock fields of an instant in an IANA zone.
function wall(at: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, Number(x.value)]));
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
}

// Zone offset (ms) at an instant.
function offset(at: number, timeZone: string) {
  const w = wall(new Date(at), timeZone);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - (at - (((at % 1000) + 1000) % 1000));
}

/** The instant a local date + time happens in `timeZone`. A time skipped by DST runs after the gap (02:30 → 03:30). */
function zoned(y: number, m: number, d: number, h: number, mi: number, timeZone: string) {
  const local = Date.UTC(y, m - 1, d, h, mi);
  const first = local - offset(local, timeZone);
  return local - offset(first, timeZone);
}

/** YYYY-MM-DD of an instant in `timeZone`. */
export function localDate(at: Date, timeZone: string) {
  const { y, m, d } = wall(at, timeZone);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** First scheduled instant strictly after `after` (pause ignored). */
export function nextSlot(s: Pick<BriefSchedule, "localTime" | "timezone" | "days">, after: Date): Date {
  const [h, mi] = s.localTime.split(":").map(Number) as [number, number];
  const { y, m, d } = wall(after, s.timezone);
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i));
    if (!s.days.includes(day.getUTCDay())) continue;
    const at = zoned(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, s.timezone);
    if (at > after.getTime()) return new Date(at);
  }
  throw new Error("schedule has no days"); // BriefSchedule requires at least one
}

/** Next run shown to the owner and picked up by the tick; null while paused. */
export const nextRunAt = (s: BriefSchedule, now: Date) => (s.paused ? null : nextSlot(s, now));

/**
 * The window to run now for a watchlist whose `due` time has passed: the latest slot ≤ now, so an API that was down
 * for days runs one brief for the current window instead of replaying every missed one.
 */
export function dueWindow(s: BriefSchedule, due: Date, now: Date) {
  let at = due;
  for (let n = nextSlot(s, at); n <= now; n = nextSlot(s, at)) at = n;
  return { windowDate: localDate(at, s.timezone), next: nextSlot(s, now) };
}
