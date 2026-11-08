import { costUsd, type CostUsage } from "./ai-cost.ts";
import type { Db, Tx } from "./db/index.ts";
import type { AiSpendSource } from "./db/schema.ts";
import { reserveAiSpend, settleAiSpend } from "./system.ts";

// FR-CSP-08 / GATE-09 for single model calls an owner's request waits on (Explain, Triage, Talk, plan drafting):
// the worst-case cap is reserved in the caller's claim transaction (an engaged emergency stop or a spent budget
// refuses with 409 before anything is stored or called), then the call settles to the cost measured from its usage.

export type CallSpend = { spendId: string; model: string; maxUsd: number };

/** Reserves `maxUsd` for one call by `model` (stop and budget checked, same 409s as every metered path). */
export async function reserveCall(
  tx: Tx,
  i: {
    workspaceId: string;
    projectId: string;
    source: AiSpendSource;
    sourceId: string;
    model: string;
    maxUsd: number;
    timezone: string;
  },
): Promise<CallSpend> {
  const { spendId } = await reserveAiSpend(tx, i);
  return { spendId, model: i.model, maxUsd: i.maxUsd };
}

/**
 * Runs the reserved call and settles its reservation once: to the cost of the response's `usage` when one arrived
 * (a rejected answer is billed too), else to the whole cap, since a provider error, timeout or abort may still have
 * been billed. A throwing call is settled the same way before the error goes on.
 */
export async function meteredCall<T extends object>(
  db: Db,
  spend: CallSpend,
  call: () => Promise<T>,
): Promise<{ res: T; costUsd: number }> {
  let res: T;
  try {
    res = await call();
  } catch (err) {
    await settleAiSpend(db, spend.spendId, spend.maxUsd).catch(() => undefined); // unsettled counts in full anyway
    throw err;
  }
  const usage = "usage" in res ? (res.usage as CostUsage | undefined) : undefined;
  const cost = usage ? costUsd(spend.model, usage) : spend.maxUsd;
  await settleAiSpend(db, spend.spendId, cost);
  return { res, costUsd: cost };
}
