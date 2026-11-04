import type { AgentKey } from "@nexus/contracts";

// Display names where an agent's profile isn't loaded (the agents API sends its own `label`).
export const AGENT_LABEL: Record<AgentKey, string> = {
  CHIEF_OF_STAFF: "Chief of Staff",
  DEVELOPER: "Developer",
  QA: "QA",
  DEVOPS: "DevOps",
  PRODUCT: "Product",
  AI_RESEARCHER: "AI researcher",
  FINANCIAL_ANALYST: "Financial analyst",
};

// Agents that only work on Business data: hidden while the owner hides the Business workspace.
export const BUSINESS_AGENTS: ReadonlySet<AgentKey> = new Set<AgentKey>(["FINANCIAL_ANALYST"]);
