import { useEffect } from "react";
import { animate, m, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import type { HomeKpi } from "@nexus/contracts";

// The four Dev KPIs of the Cofounder home (PRD §D.4 "Live KPIs"). Every number is NEXUS's own record from
// GET /v1/home; a KPI without data shows "—", never 0.

const EASE = [0.2, 0.8, 0.2, 1] as const;

function minutesText(n: number): string {
  const r = Math.round(n);
  return r < 60 ? `${r} min` : `${Math.floor(r / 60)} h ${r % 60} min`;
}

export function kpiText(unit: HomeKpi["unit"], v: number): string {
  if (unit === "minutes") return minutesText(v);
  if (unit === "ratio") return `${Math.round(v * 100)}%`;
  return String(Math.round(v));
}

/**
 * The delta chip: worded by direction and coloured by `better`, so it never relies on colour alone. Null without a
 * previous window to compare with (e.g. WAITING_ON_YOU, which has no honest history).
 */
export function kpiDelta(k: HomeKpi): { text: string; tone: string } | null {
  if (k.value === null) return { text: "no data yet", tone: "var(--ink3)" };
  if (k.previous === null) return null;
  const diff = k.value - k.previous;
  const size = Math.round(Math.abs(k.unit === "ratio" ? diff * 100 : diff));
  if (size === 0) return { text: "same as last week", tone: "var(--ink2)" };
  const up = diff > 0;
  const amount = k.unit === "minutes" ? minutesText(size) : k.unit === "ratio" ? `${size} pt` : String(size);
  const word =
    k.unit === "minutes"
      ? up
        ? "slower"
        : "faster"
      : k.unit === "ratio"
        ? up
          ? "higher"
          : "lower"
        : up
          ? "more"
          : "fewer";
  return {
    text: `${amount} ${word} than last week`,
    tone: up === (k.better === "UP") ? "var(--green)" : "var(--amber)",
  };
}

/** The value eases in from 0 (or from the last value on a refresh); screen readers get only the final number. */
function Eased({ value, unit }: { value: number; unit: HomeKpi["unit"] }) {
  const reduced = useReducedMotion();
  const mv = useMotionValue(reduced ? value : 0);
  const text = useTransform(mv, (v) => kpiText(unit, v));
  useEffect(() => {
    if (reduced) {
      mv.set(value);
      return;
    }
    const run = animate(mv, value, { duration: 0.9, ease: EASE });
    return () => run.stop();
  }, [mv, value, reduced]);
  return (
    <span className="font-serif text-[38px] leading-none">
      <span className="sr-only">{kpiText(unit, value)}</span>
      <m.span aria-hidden="true">{text}</m.span>
    </span>
  );
}

const W = 200;
const H = 40;

/** 7 daily values, oldest first; a null day breaks the line instead of drawing a fake 0. */
function Sparkline({ k, tone }: { k: HomeKpi; tone: string }) {
  const reduced = useReducedMotion();
  const known = k.series.filter((v): v is number => v !== null);
  const label = `Last 7 days: ${k.series.map((v) => (v === null ? "no data" : kpiText(k.unit, v))).join(", ")}`;
  if (!known.length)
    return (
      <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} className="block h-[38px] w-full">
        <line
          x1="0"
          y1={H - 2}
          x2={W}
          y2={H - 2}
          stroke="var(--hair)"
          strokeWidth="1.5"
          strokeDasharray="4 4"
        />
      </svg>
    );
  const lo = Math.min(...known);
  const span = Math.max(...known) - lo || 1;
  const runs: [number, number][][] = [];
  let open = false;
  k.series.forEach((v, i) => {
    if (v === null) {
      open = false;
      return;
    }
    const p: [number, number] = [(i / (k.series.length - 1)) * W, 36 - ((v - lo) / span) * 30];
    if (open) runs.at(-1)!.push(p);
    else runs.push([p]);
    open = true;
  });
  const xy = ([x, y]: [number, number]) => `${x.toFixed(1)},${y.toFixed(1)}`;
  // A lone day is a dot: a near-zero segment drawn with a round cap.
  const line = runs
    .map(
      (r) =>
        `M${xy(r[0]!)}${
          r.length === 1
            ? " h0.1"
            : r
                .slice(1)
                .map((p) => ` L${xy(p)}`)
                .join("")
        }`,
    )
    .join(" ");
  const area = runs
    .filter((r) => r.length > 1)
    .map(
      (r) =>
        `M${xy(r[0]!)}${r
          .slice(1)
          .map((p) => ` L${xy(p)}`)
          .join("")} L${r.at(-1)![0].toFixed(1)},${H} L${r[0]![0].toFixed(1)},${H} Z`,
    )
    .join(" ");
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="block h-[38px] w-full overflow-visible"
    >
      {area && <path d={area} fill={tone} opacity="0.1" />}
      <m.path
        d={line}
        fill="none"
        stroke={tone}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
        initial={reduced ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.1, ease: EASE }}
      />
    </svg>
  );
}

/**
 * Always four cards (the contract says so): four across when the column has room for ~200px each, else 2×2, else one
 * column, never 3 + 1. It measures its own column (a container), which is narrower with the Cofounder panel docked.
 */
export function KpiCards({ kpis }: { kpis: readonly HomeKpi[] }) {
  return (
    <div className="@container">
      <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 @sm:grid-cols-2 @min-[52rem]:grid-cols-4">
        {kpis.map((k) => {
          const d = kpiDelta(k);
          const tone = d?.tone === "var(--amber)" ? "var(--amber)" : "var(--teal)";
          return (
            <li
              key={k.key}
              className="flex min-w-0 flex-col gap-2.5 rounded-[18px] border border-line bg-card px-4 pt-4 pb-3.5 shadow-nx"
            >
              <h3 className="m-0 text-[12.5px] leading-tight font-normal text-ink2">{k.label}</h3>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1.5">
                {k.value === null ? (
                  <span className="font-serif text-[38px] leading-none text-ink3">—</span>
                ) : (
                  <Eased value={k.value} unit={k.unit} />
                )}
                {d && (
                  <span
                    className="rounded-[7px] px-[7px] py-1 font-mono text-[11px] leading-none"
                    style={{ color: d.tone, background: `color-mix(in oklch, ${d.tone} 12%, transparent)` }}
                  >
                    {d.text}
                  </span>
                )}
              </div>
              <Sparkline k={k} tone={tone} />
              <span className="font-mono text-[11px] leading-snug text-ink3">{k.source}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
