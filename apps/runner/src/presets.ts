import type { DiagnosticPreset } from "@nexus/contracts";

// Fixed allowlist: the API only ever sends a preset key, never a command string.
// The argv runs inside the job container (or on the host with RUNNER_SANDBOX=none).
export const PRESET_ARGV: Readonly<Record<DiagnosticPreset, readonly [string, ...string[]]>> = {
  "host-info": ["uname", "-a"],
  "node-version": ["node", "--version"],
  "git-version": ["git", "--version"],
};
