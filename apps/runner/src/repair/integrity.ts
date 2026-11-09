import type { ChangesetFile } from "@nexus/contracts";

export type IntegrityResult = { clean: boolean; problems: string[]; testFilesChanged: string[] };

// The upload contract caps problems at 50 entries.
const MAX_PROBLEMS = 50;
const MAX_PROBLEM_LENGTH = 199;

const TEST_DIRS = new Set(["__tests__", "test", "tests", "spec"]);
const TEST_NAME = /(?:\.(?:test|spec)\.[^/]+|_test\.[^/]+|^test_[^/]*\.py|Test\.java|Tests\.cs)$/;
const CONFIG_PREFIXES = [
  "vitest.config",
  "vitest.workspace",
  "jest.config",
  "playwright.config",
  "karma.conf",
  "pytest.ini",
  ".mocharc",
  "phpunit.xml",
];

// Skip and focus markers. A marker counts only when the file has more of it than the base file.
const MARKERS: RegExp[] = [
  /\.(?:only|skip\w*|todo|fixme)\b/g,
  /(?<![\w.])(?:xit|xdescribe|xtest|fit|fdescribe|ftest)\s*\(/g,
  /@(?:Ignore|Disabled)\b/g,
  /\[Ignore\b/g,
  /\bSkip\s*=/g,
  /pytest\.mark\.(?:skip|skipif|xfail)\b/g,
  /\bunittest\.skip/g,
  /\b[tb]\.Skip\w*\s*\(/g,
  /\bpytest\.skip\s*\(/g,
  /\bpytest\.importorskip\s*\(/g,
  /\.skipTest\s*\(/g,
];

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

export function isTestFile(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1] ?? "";
  return parts.slice(0, -1).some((d) => TEST_DIRS.has(d)) || TEST_NAME.test(name);
}

const isRunnerConfig = (path: string): boolean => {
  if (path === ".nexus.json" || path === "conftest.py") return true;
  const name = baseName(path);
  return CONFIG_PREFIXES.some((p) => name.startsWith(p));
};

// Decoded text, or null for content that isn't valid UTF-8 (binary files are skipped, never an error).
function decode(file: ChangesetFile): string | null | undefined {
  if (file.change === "deleted") return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(file.contentBase64, "base64"));
  } catch {
    return null;
  }
}

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

const exceedsBaseMarkers = (text: string, base: string | null): boolean =>
  MARKERS.some((re) => count(text, re) > (base === null ? 0 : count(base, re)));

// Only what decides what "test" means: scripts.test and the jest/vitest keys.
function packageJsonTestConfig(text: string | null): string | null {
  if (text === null) return JSON.stringify([null, null, null]);
  try {
    const j = JSON.parse(text) as { scripts?: { test?: unknown }; jest?: unknown; vitest?: unknown };
    return JSON.stringify([j.scripts?.test ?? null, j.jest ?? null, j.vitest ?? null]);
  } catch {
    return null;
  }
}

// The [tool.pytest*] tables of a pyproject.toml.
function pytestSection(text: string | null): string {
  if (text === null) return "";
  const kept: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[+\s*([^\]]*?)\s*\]+/.exec(line);
    if (header) inside = (header[1] ?? "").startsWith("tool.pytest");
    if (inside) kept.push(line.trimEnd());
  }
  return kept.join("\n");
}

const clip = (s: string): string =>
  s.length > MAX_PROBLEM_LENGTH ? `${s.slice(0, MAX_PROBLEM_LENGTH - 1)}…` : s;

// Deterministic check that the change didn't weaken what the tests prove. Editing existing tests is allowed;
// the approval lists them so the owner can look.
export async function checkIntegrity(
  files: ChangesetFile[],
  base: (path: string) => Promise<string | null>,
): Promise<IntegrityResult> {
  const problems: string[] = [];
  const testFilesChanged: string[] = [];
  const add = (s: string) => problems.push(clip(s));

  for (const file of files) {
    const { path } = file;
    const name = baseName(path);
    const test = isTestFile(path);
    if (test) testFilesChanged.push(path);

    if (file.change === "deleted") {
      if (test) add(`Deleted test file ${path}`);
      else if (isRunnerConfig(path)) add(`Deleted test configuration ${path}`);
      else if (
        name === "package.json" &&
        packageJsonTestConfig(await base(path)) !== packageJsonTestConfig(null)
      ) {
        add(`Deleted ${path}, which defines the test script`);
      }
      continue;
    }

    const text = decode(file);
    if (text === null || text === undefined) continue;

    const before = await base(path);
    if (isRunnerConfig(path)) {
      if (before !== text) add(`Changed test configuration ${path}`);
    } else if (name === "package.json") {
      const next = packageJsonTestConfig(text);
      const prev = packageJsonTestConfig(before);
      if (next === null) add(`${path} is no longer valid JSON`);
      else if (next !== prev) add(`Changed the test script or test settings in ${path}`);
    } else if (name === "pyproject.toml") {
      if (pytestSection(text) !== pytestSection(before)) add(`Changed the pytest settings in ${path}`);
    }

    if (test && exceedsBaseMarkers(text, before)) add(`Added a skip or focus marker to test file ${path}`);
  }

  return {
    clean: problems.length === 0,
    problems: problems.slice(0, MAX_PROBLEMS),
    testFilesChanged: [...new Set(testFilesChanged)],
  };
}
