import { createHash } from "node:crypto";
import type { Verification } from "@nexus/contracts";

export type FailureClass = "repair" | "environment" | "needs_dependency" | "not_configured";

// Narrow on purpose: a test that merely prints "not found" must not be read as a broken environment.
const ENVIRONMENT_PATTERNS = [
  /^\s*(?:\S*\/)?(?:sh|bash|zsh|dash): (?:\d+: )?[^\s:]+: not found\s*$/m,
  /command not found/i,
  /getaddrinfo ENOTFOUND/,
  /getaddrinfo EAI_AGAIN/,
  /\bEAI_AGAIN\b/,
  /\bECONNREFUSED\b.*\b(?:registry|npm|pnpm|yarn|pypi|crates)\b/i,
  /\b(?:registry|npm|pnpm|yarn|pypi|crates)\b.*\bECONNREFUSED\b/i,
];

const MANIFEST_BASENAMES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "pipfile",
  "pipfile.lock",
  "cargo.toml",
  "cargo.lock",
  "go.mod",
  "go.sum",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1).toLowerCase();

const touchesManifest = (paths: string[]): boolean =>
  paths.some((p) => {
    const b = baseName(p);
    return MANIFEST_BASENAMES.has(b) || /^requirements.*\.txt$/.test(b);
  });

const looksLikeEnvironment = (v: Verification): boolean =>
  v.exitCode === 127 || ENVIRONMENT_PATTERNS.some((re) => re.test(v.outputTail));

// Decides what NEXUS does with a test result that didn't pass. failureKind wins when the runner recorded it;
// otherwise it is inferred from status, reason and the tail of the output.
export function classifyFailure(v: Verification, changedPaths: string[]): FailureClass {
  switch (v.failureKind) {
    case "test_failed":
    case "test_timeout":
      return "repair";
    case "environment":
      return "environment";
    case "needs_dependency":
      return "needs_dependency";
    case "not_configured":
      return "not_configured";
    case "install_failed":
      return touchesManifest(changedPaths) ? "needs_dependency" : "environment";
    case undefined:
      break;
  }
  if (v.status === "not_configured") return "not_configured";
  if (v.status === "error") {
    const reason = v.reason ?? "";
    if (/install/i.test(reason)) return touchesManifest(changedPaths) ? "needs_dependency" : "environment";
    if (/time(?:d)?[ -]?out/i.test(reason)) return "repair";
    return "environment";
  }
  if (looksLikeEnvironment(v)) return "environment";
  return "repair";
}

// eslint-disable-next-line no-control-regex -- matching the ESC byte is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|m|min)\b/gi;
const ABS_PATH = /(?:[A-Za-z]:)?(?:\/[^\s/:'"()]+){2,}/g;

// null when nothing meaningful is left: unknown, never a repeat.
// Stable id for "the same failure again": timings, absolute paths and numbers don't change it.
export function fingerprint(outputTail: string): string | null {
  const normalized = outputTail
    .replace(ANSI, "")
    .replace(DURATION, "")
    .replace(ABS_PATH, "<path>")
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[a-z]/i.test(normalized)) return null;
  return createHash("sha256").update(normalized).digest("hex");
}
