import { AgentTool, type AgentKey, type EffectiveAgentProfile } from "@nexus/contracts";
import type { Db } from "./db/index.ts";
import { resolveProject } from "./workspaces.ts";

// Stand-in for agent A's `resolveAgentProfile` (apps/api/src/agents/service.ts), same signature. The coordinator
// deletes this file at merge and points its importers at the real one.
export async function resolveAgentProfile(
  db: Db,
  ownerId: string,
  projectId: string,
  agent: AgentKey,
): Promise<EffectiveAgentProfile> {
  await resolveProject(db, ownerId, projectId); // read-only, as the real resolver does
  return {
    agent,
    versionId: null,
    level: "DEFAULT",
    version: 0,
    settings: {
      engine: "MESSAGES_API",
      autonomy: "ACT_WITH_APPROVAL",
      tools: [...AgentTool.options],
      maxCostUsdPerTask: 1,
      maxTurns: 10,
      responseDetail: "STANDARD",
    },
    ceilingApplied: [],
  };
}
