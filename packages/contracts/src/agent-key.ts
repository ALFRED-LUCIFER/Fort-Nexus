import { z } from "zod";

export const AgentKey = z.enum([
  "CHIEF_OF_STAFF",
  "DEVELOPER",
  "QA",
  "DEVOPS",
  "PRODUCT",
  "AI_RESEARCHER",
  "FINANCIAL_ANALYST",
]);
export type AgentKey = z.infer<typeof AgentKey>;
