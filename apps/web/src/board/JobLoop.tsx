import type { ReactNode } from "react";
import { isTerminal, type JobStatus, type QaReview, type Verification } from "@nexus/contracts";
import { duration } from "../lib/queries.ts";
import { Markdown } from "./Markdown.tsx";
import { STOP_WORD, roundLabel, roundResult, type LoopView, type StuckView, PHASES } from "./loopEvents.ts";
import { TEST_WORD } from "./runEvents.ts";

const card = "flex flex-none flex-col gap-2.5 rounded-[18px] border border-hair p-4";
const heading = "kicker m-0";

const testSentence = (v: Verification) =>
  `${TEST_WORD[v.status]}${v.exitCode === null ? "" : ` (exit ${v.exitCode})`} · ${duration(v.durationMs)}`;

const PHASE_TITLE: Record<(typeof PHASES)[number], string> = {
  understand: "Understand",
  spec: "Spec",
  grill: "Grill the spec",
  red: "Red: a test that fails first",
  green: "Green: the smallest change",
  review: "Review its own diff",
};

/**
 * The repair loop as the owner follows it: round counter, each round's result in words, why it stopped, what the agent
 * planned, the QA review and, when the loop ended without a pass, the stuck report. Nothing here is the agent's claim
 * about tests: rounds and test runs are NEXUS's own events; the agent's text and the QA review are labelled.
 */
export function JobLoop({
  view,
  status,
  stuck,
  qa,
}: {
  view: LoopView;
  status: JobStatus;
  stuck: StuckView;
  /** The approval's QA once there is one (it is what the owner decides on), else the latest event. */
  qa: QaReview | undefined;
}) {
  const live = !isTerminal(status);
  const counter = roundLabel(view);
  const nothing =
    !counter &&
    !view.opening &&
    !view.phases.length &&
    !view.checks.length &&
    !qa &&
    !stuck.report &&
    !view.stopped;
  if (nothing) return null;
  const last = view.rounds.at(-1);
  return (
    <div className="flex flex-none flex-col gap-3.5">
      {(counter || view.opening || view.stopped) && (
        <section aria-labelledby="loop-rounds" className={card}>
          <h3 id="loop-rounds" className={heading}>
            Rounds · counted by NEXUS
          </h3>
          {counter && last && (
            <p role="status" className="m-0 text-[15px] leading-tight font-medium text-ink">
              {counter}
              <span className="font-normal text-ink2">
                {live && last.result === undefined
                  ? ` · ${last.kind === "repair" ? "repairing" : "first attempt"} now`
                  : live
                    ? " · between rounds"
                    : " · the last round"}
              </span>
            </p>
          )}
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {view.opening && (
              <li className="text-[12.5px] leading-[1.5] text-ink2">
                <strong className="font-medium text-ink">Before any round:</strong> NEXUS ran the tests on the
                saved changes first: {testSentence(view.opening)}.
              </li>
            )}
            {view.rounds.map((r) => (
              <li key={r.round} className="text-[12.5px] leading-[1.5] text-ink2">
                <strong className="font-medium text-ink">
                  Round {r.round} of {r.of}
                </strong>{" "}
                ({r.kind === "repair" ? "repair" : "first attempt"}): {roundResult(r)}.
                {r.summary && r.summary !== roundResult(r) && <> {r.summary}</>}
                {r.tests.map((t, i) => (
                  <span key={i} className="block font-mono text-[11.5px] text-ink3">
                    NEXUS test run: {testSentence(t)}
                  </span>
                ))}
              </li>
            ))}
          </ol>
          {view.stopped && (
            <p className="m-0 text-[12.5px] leading-[1.5] text-ink">
              <strong className="font-medium">Stopped:</strong>{" "}
              {STOP_WORD[view.stopped.reason] ?? view.stopped.reason.replaceAll("_", " ")}
            </p>
          )}
        </section>
      )}
      {view.checks.length > 0 && (
        <section aria-labelledby="loop-checks" className={card}>
          <h3 id="loop-checks" className={heading}>
            Checks NEXUS ran along the way
          </h3>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {view.checks.map((c, i) => (
              <li key={i} className="text-[12.5px] leading-[1.5] text-ink2">
                {c.only === "base" ? "The tests on the base commit" : "The new tests without the change"}:{" "}
                {testSentence(c.verification)}
                {c.only === "base" &&
                  c.verification.status === "failed" &&
                  " (they fail without the change too)"}
                {c.only === "red" &&
                  c.verification.status === "passed" &&
                  " (they pass without the change too)"}
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.phases.length > 0 && (
        <section aria-labelledby="loop-understood" className={card}>
          <h3 id="loop-understood" className={heading}>
            What the agent understood
          </h3>
          <p className="m-0 text-[12px] leading-[1.45] text-ink3">
            Written by the agent as it worked. It is the agent&apos;s own account and is not checked.
          </p>
          <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
            {view.phases.map((p, i) => (
              <li key={`${p.phase}-${i}`} className="flex flex-col gap-1">
                <span className="text-[12.5px] font-medium text-ink">
                  {PHASE_TITLE[p.phase]}
                  {p.round !== undefined && p.round > 0 && (
                    <span className="font-normal text-ink3"> · round {p.round}</span>
                  )}
                </span>
                <Markdown text={p.text} headingLevel={4} className="text-[12.5px] leading-[1.5] text-ink2" />
              </li>
            ))}
          </ol>
        </section>
      )}
      {qa && <QaBlock qa={qa} />}
      {stuck.report && <StuckReportCard stuck={stuck} view={view} />}
    </div>
  );
}

const WORD_SEVERITY = { blocking: "Blocking", minor: "Minor" } as const;

/** QA's verdict and defects, labelled as a model's opinion (never a verified fact). Blocking defects first. */
export function QaBlock({ qa, id = "qa-review" }: { qa: QaReview; id?: string }) {
  const defects = [...qa.defects].sort(
    (a, b) => Number(b.severity === "blocking") - Number(a.severity === "blocking"),
  );
  return (
    <section aria-labelledby={id} className={card}>
      <h3 id={id} className={heading}>
        QA review (AI opinion)
      </h3>
      <p className="m-0 text-[13px] leading-[1.5] font-medium text-ink">
        {qa.status === "could_not_run"
          ? `The review didn't run${qa.reason ? `: ${qa.reason}` : "."} Nothing here was reviewed by QA.`
          : qa.verdict === "pass"
            ? "The reviewer found no defects. That is its opinion, not proof."
            : `The reviewer reports ${defects.length} ${defects.length === 1 ? "defect" : "defects"}. That is its opinion: check them yourself.`}
      </p>
      {defects.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {defects.map((d, i) => (
            <li key={i} className="text-[12.5px] leading-[1.5] break-words text-ink2">
              <strong className="font-medium text-ink">{WORD_SEVERITY[d.severity]}</strong>
              {d.file && <span className="font-mono text-[11.5px]"> · {d.file}</span>}
              <span className="block">{d.evidence}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Why the loop ended without a pass: what was tried, what still fails, the agent's guess (labelled), the next step. */
function StuckReportCard({ stuck, view }: { stuck: StuckView; view: LoopView }): ReactNode {
  const r = stuck.report;
  if (!r) return null;
  return (
    <section aria-labelledby="loop-stuck" className={`${card} border-[var(--amber)]`}>
      <h3 id="loop-stuck" className={heading}>
        Why it stopped
      </h3>
      {view.stopped && (
        <p className="m-0 text-[13px] leading-[1.5] font-medium text-ink">
          {STOP_WORD[view.stopped.reason] ?? view.stopped.reason.replaceAll("_", " ")}
        </p>
      )}
      {r.rounds.length > 0 && (
        <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
          {r.rounds.map((x) => (
            <li key={x.round} className="text-[12.5px] leading-[1.5] break-words text-ink2">
              <strong className="font-medium text-ink">Round {x.round} tried:</strong> {x.tried}{" "}
              <span className="text-ink3">Result: {x.result}</span>
            </li>
          ))}
        </ol>
      )}
      <Fact term="Still failing">{r.stillFailing}</Fact>
      {r.rootCauseGuess && <Fact term="Best guess (from the agent)">{r.rootCauseGuess}</Fact>}
      {r.rootCauseGuess && (
        <p className="m-0 text-[12px] leading-[1.45] text-ink3">
          The guess is the agent&apos;s own opinion and hasn&apos;t been tested.
        </p>
      )}
      <Fact term="Recommended next step">{r.nextStep}</Fact>
    </section>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <p className="m-0 text-[12.5px] leading-[1.5] break-words text-ink2">
      <strong className="font-medium text-ink">{term}:</strong> {children}
    </p>
  );
}

/** NEXUS's own findings about the change (not the agent's, not QA's), shown on the approval. */
export function NexusNotes({ notes }: { notes: readonly string[] }) {
  if (!notes.length) return null;
  return (
    <section aria-labelledby="nexus-notes" className="flex flex-col gap-1.5">
      <h4 id="nexus-notes" className="m-0 text-[12px] font-medium text-ink">
        Open findings from NEXUS
      </h4>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {notes.map((n, i) => (
          <li key={i} className="text-[12.5px] leading-[1.45] break-words text-ink2">
            {n}
          </li>
        ))}
      </ul>
    </section>
  );
}
