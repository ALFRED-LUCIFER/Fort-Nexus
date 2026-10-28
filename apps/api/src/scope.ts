// Every P1 row, query and audit record carries workspaceId + projectId (PRD Part B rule 5, FR-CSP-01).
// shortcut: one fixed placeholder project until the workspace model lands on main (MVP wave 6); then resolve it from
// the request (URL scope + membership check) here and nowhere else.
export const P1_SCOPE = {
  workspaceId: "00000000-0000-7000-8000-000000000001",
  projectId: "00000000-0000-7000-8000-000000000002",
} as const;

export type ProjectScope = { workspaceId: string; projectId: string };

export const projectScope = (): ProjectScope => P1_SCOPE;
