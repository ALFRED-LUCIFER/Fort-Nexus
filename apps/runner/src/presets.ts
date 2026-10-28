import type { DiagnosticPreset } from "@nexus/contracts";

// Fixed allowlist: the API only ever sends a preset key, never a command string.
export const PRESET_ARGV: Readonly<Record<DiagnosticPreset, readonly [string, ...string[]]>> = {
  "host-info": ["uname", "-a"],
  "node-version": [process.execPath, "--version"],
  "git-version": ["git", "--version"],
};
