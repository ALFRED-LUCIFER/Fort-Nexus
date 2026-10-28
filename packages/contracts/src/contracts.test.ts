import { describe, expect, it } from "vitest";
import {
  BriefSchedule,
  ChangesetFile,
  Intent,
  QualifiedTable,
  ResearchSource,
  ScoringWeights,
  SqlIdentifier,
  CreateJobRequest,
  JOB_TRANSITIONS,
  JobStatus,
  TERMINAL_JOB_STATUSES,
  canTransition,
  runnerStatus,
} from "./index.ts";

describe("job state machine", () => {
  it("terminal states have no exits", () => {
    for (const s of TERMINAL_JOB_STATUSES) expect(JOB_TRANSITIONS[s]).toEqual([]);
  });

  it("only references known states", () => {
    for (const targets of Object.values(JOB_TRANSITIONS))
      for (const t of targets) expect(JobStatus.options).toContain(t);
  });

  it("follows the PRD happy path and rejects skips", () => {
    const path = ["DRAFT", "VALIDATING", "QUEUED", "PREPARING", "RUNNING", "VERIFYING", "COMPLETED"] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
    expect(canTransition("QUEUED", "COMPLETED")).toBe(false);
    expect(canTransition("COMPLETED", "QUEUED")).toBe(false);
  });
});

describe("CreateJobRequest", () => {
  it("rejects shell text and unknown fields", () => {
    expect(CreateJobRequest.safeParse({ jobType: "RUNNER_DIAGNOSTIC", preset: "rm -rf /" }).success).toBe(
      false,
    );
    expect(
      CreateJobRequest.safeParse({ jobType: "RUNNER_DIAGNOSTIC", preset: "node-version", cmd: "ls" }).success,
    ).toBe(false);
    expect(CreateJobRequest.safeParse({ jobType: "RUNNER_DIAGNOSTIC", preset: "node-version" }).success).toBe(
      true,
    );
  });
});

describe("runnerStatus", () => {
  const now = new Date("2026-10-28T10:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  it("maps heartbeat age to ONLINE / STALE / OFFLINE", () => {
    expect(runnerStatus(ago(1_000), false, now)).toBe("ONLINE");
    expect(runnerStatus(ago(30_000), false, now)).toBe("STALE");
    expect(runnerStatus(ago(120_000), false, now)).toBe("OFFLINE");
    expect(runnerStatus(null, false, now)).toBe("OFFLINE");
    expect(runnerStatus(ago(1_000), true, now)).toBe("REVOKED");
  });
});

describe("DEV_ISSUE_TO_PR", () => {
  it("applies budget defaults and caps", () => {
    const r = CreateJobRequest.parse({ jobType: "DEV_ISSUE_TO_PR", repositoryId: "123", issueNumber: 42 });
    expect(r).toMatchObject({ budget: { maxWallClockMinutes: 45, maxTurns: 60, maxCostUsd: 5 } });
    expect(
      CreateJobRequest.safeParse({
        jobType: "DEV_ISSUE_TO_PR",
        repositoryId: "123",
        issueNumber: 42,
        budget: { maxCostUsd: 500 },
      }).success,
    ).toBe(false);
    expect(
      CreateJobRequest.safeParse({ jobType: "RUNNER_DIAGNOSTIC", preset: "host-info", repositoryId: "1" })
        .success,
    ).toBe(false);
  });

  it("rejects changeset paths that escape the repo or touch .git", () => {
    const file = (path: string) => ({ change: "added", path, mode: "100644", contentBase64: "aGk=" });
    for (const bad of ["../x", "/etc/passwd", "a/../../b", ".git/config", "a//b", "a\\b", "./a"])
      expect(ChangesetFile.safeParse(file(bad)).success, bad).toBe(false);
    for (const ok of ["src/a.ts", ".github/workflows/ci.yml", "a/.gitignore"])
      expect(ChangesetFile.safeParse(file(ok)).success, ok).toBe(true);
  });

  it("lets the server finish an approved action", () => {
    expect(canTransition("VERIFYING", "AWAITING_APPROVAL")).toBe(true);
    expect(canTransition("AWAITING_APPROVAL", "COMPLETED")).toBe(true);
  });
});

describe("P1 wave 1 contracts", () => {
  it("BriefSchedule needs a real IANA zone and a 24h time", () => {
    expect(BriefSchedule.safeParse({ localTime: "08:00", timezone: "Asia/Dubai" }).success).toBe(true);
    expect(BriefSchedule.safeParse({ localTime: "08:00", timezone: "Mars/Olympus" }).success).toBe(false);
    expect(BriefSchedule.safeParse({ localTime: "24:00", timezone: "UTC" }).success).toBe(false);
  });

  it("ScoringWeights rejects all-zero weights", () => {
    const zero = { credibility: 0, relevance: 0, novelty: 0, impact: 0, opportunity: 0 };
    expect(ScoringWeights.safeParse(zero).success).toBe(false);
    expect(ScoringWeights.safeParse({ ...zero, novelty: 1 }).success).toBe(true);
  });

  it("feeds are https only and carry no extra fields", () => {
    expect(
      ResearchSource.safeParse({ kind: "FEED", url: "http://x.dev/feed", tier: "PRIMARY" }).success,
    ).toBe(false);
    expect(
      ResearchSource.safeParse({ kind: "FEED", url: "https://x.dev/feed", tier: "PRIMARY", cookie: "a" })
        .success,
    ).toBe(false);
  });

  it("metric dictionary identifiers can't smuggle SQL", () => {
    expect(QualifiedTable.safeParse("public.orders").success).toBe(true);
    expect(QualifiedTable.safeParse('public.orders; drop table "x"').success).toBe(false);
    expect(SqlIdentifier.safeParse("Amount").success).toBe(false);
  });

  it("intents are a closed set: no shell or free-form action", () => {
    expect(Intent.safeParse({ kind: "RUN_SHELL", command: "rm -rf /" }).success).toBe(false);
    expect(Intent.safeParse({ kind: "LIST_RUNS", command: "x" }).success).toBe(false);
  });
});
