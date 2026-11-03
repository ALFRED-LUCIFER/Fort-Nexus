// A scripted deep-dive service behind the DeepDives seam (src/plans/deep-dives.ts): idempotent per
// (projectId, Idempotency-Key) like the real one, with the test deciding each dive's status and report.
//   const dives = fakeDeepDives();
//   vi.mock("../src/plans/deep-dives.ts", ...) → deepDiveOps: () => dives.ops   (the app's own wiring)
//   createPlanExecutor({ ..., deepDives: dives.ops }, log)                     (a direct deps seam)
import { randomUUID } from "node:crypto";
import type { CreateDeepDiveRequest, DeepDiveDetail, DeepDiveReport } from "@nexus/contracts";
import { notFound } from "../../src/errors.ts";
import type { DeepDives } from "../../src/plans/deep-dives.ts";
import type { Ctx } from "../../src/research/service.ts";

export const report = (over: Partial<DeepDiveReport> = {}): DeepDiveReport => ({
  summary: "Carts are abandoned at shipping [0].",
  claims: [
    {
      id: 0,
      text: "Most carts are abandoned at the shipping step.",
      basis: "OBSERVED",
      label: "PRIMARY",
      evidence: [
        {
          url: "https://research.example/carts",
          publisher: "research.example",
          tier: "PRIMARY",
          quote: "most carts are abandoned at the shipping step",
          verified: true,
          snapshotId: randomUUID(),
        },
      ],
    },
  ],
  contradictions: [],
  openQuestions: [],
  confidence: "MEDIUM",
  opportunity: null,
  ...over,
});

export function fakeDeepDives() {
  const byKey = new Map<string, DeepDiveDetail>();
  const byId = new Map<string, DeepDiveDetail>();
  const calls = {
    create: [] as { ctx: Ctx; body: CreateDeepDiveRequest; key: string; created: boolean }[],
    cancel: [] as string[],
  };
  const ops: DeepDives = {
    async create(ctx, body, key) {
      const existing = byKey.get(`${body.projectId}:${key}`);
      calls.create.push({ ctx, body, key, created: !existing });
      if (existing) return { created: false, deepDive: existing };
      const dive: DeepDiveDetail = {
        id: randomUUID(),
        projectId: body.projectId,
        question: body.question,
        depth: body.depth,
        findingIds: body.findingIds,
        status: "QUEUED",
        stoppedBy: null,
        limits: { maxCostUsd: body.maxCostUsd, maxTurns: 30, maxSearches: 10, maxFetches: 16 },
        usage: { costUsd: 0, turns: 0, searches: 0, fetches: 0 },
        model: "claude-test-model",
        profileVersionId: null,
        report: null,
        opportunityId: null,
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        steps: [],
      };
      byKey.set(`${body.projectId}:${key}`, dive);
      byId.set(dive.id, dive);
      return { created: true, deepDive: dive };
    },
    async get(_ownerId, id) {
      const dive = byId.get(id);
      if (!dive) throw notFound("Deep dive");
      return dive;
    },
    async cancel(_ctx, id) {
      const dive = byId.get(id);
      if (!dive) throw notFound("Deep dive");
      calls.cancel.push(id);
      Object.assign(dive, {
        status: "CANCELLED",
        error: "Cancelled by the owner",
        finishedAt: new Date().toISOString(),
      });
      return dive;
    },
  };
  /** Moves a dive as the engine would: RUNNING, then COMPLETED with a report or FAILED/CANCELLED with an error. */
  const finish = (id: string, patch: Partial<DeepDiveDetail>) => {
    const dive = byId.get(id)!;
    Object.assign(dive, { finishedAt: new Date().toISOString(), ...patch });
  };
  return { ops, calls, byId, finish };
}
