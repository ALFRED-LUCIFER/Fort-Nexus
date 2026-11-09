import type { Verification } from "@nexus/contracts";
import { describe, expect, it } from "vitest";
import { classifyFailure, fingerprint } from "./classify.ts";

const base: Verification = {
  status: "failed",
  reason: null,
  source: "package.json",
  install: null,
  test: ["pnpm", "test"],
  exitCode: 1,
  durationMs: 1000,
  outputTail: "",
};
const v = (o: Partial<Verification>): Verification => ({ ...base, ...o });

describe("classifyFailure", () => {
  it("treats a missing shell command as environment", () => {
    expect(classifyFailure(v({ outputTail: "sh: pnpm: not found", exitCode: 127 }), [])).toBe("environment");
    expect(classifyFailure(v({ outputTail: "bash: foo: command not found" }), [])).toBe("environment");
    expect(classifyFailure(v({ exitCode: 127, outputTail: "" }), [])).toBe("environment");
  });
  it("treats registry network errors as environment", () => {
    expect(
      classifyFailure(
        v({ outputTail: "request to registry failed: getaddrinfo ENOTFOUND registry.npmjs.org" }),
        [],
      ),
    ).toBe("environment");
    expect(classifyFailure(v({ outputTail: "npm ERR! code EAI_AGAIN" }), [])).toBe("environment");
    expect(classifyFailure(v({ outputTail: "connect ECONNREFUSED 10.0.0.1:443 registry fetch" }), [])).toBe(
      "environment",
    );
  });
  it("does not misread a test that prints not found", () => {
    expect(classifyFailure(v({ outputTail: "AssertionError: user not found\n1 failed" }), [])).toBe("repair");
  });
  it("repairs a timed-out test", () => {
    expect(
      classifyFailure(v({ status: "error", reason: "Test run timed out", failureKind: "test_timeout" }), []),
    ).toBe("repair");
    expect(classifyFailure(v({ status: "error", reason: "Test run timed out after 15 minutes" }), [])).toBe(
      "repair",
    );
  });
  it("needs a dependency when install failed and a manifest changed", () => {
    const f = v({ status: "error", reason: "Install failed", failureKind: "install_failed" });
    expect(classifyFailure(f, ["package.json"])).toBe("needs_dependency");
    expect(classifyFailure(f, ["apps/web/pnpm-lock.yaml"])).toBe("needs_dependency");
    expect(classifyFailure(f, ["src/a.ts"])).toBe("environment");
    expect(classifyFailure(v({ status: "error", reason: "install failed" }), ["package.json"])).toBe(
      "needs_dependency",
    );
  });
  it("uses failureKind first", () => {
    expect(classifyFailure(v({ failureKind: "test_failed", outputTail: "sh: x: not found" }), [])).toBe(
      "repair",
    );
    expect(classifyFailure(v({ failureKind: "not_configured" }), [])).toBe("not_configured");
    expect(classifyFailure(v({ failureKind: "needs_dependency" }), [])).toBe("needs_dependency");
    expect(classifyFailure(v({ failureKind: "environment" }), [])).toBe("environment");
  });
  it("maps status not_configured and a run that could not start", () => {
    expect(classifyFailure(v({ status: "not_configured" }), [])).toBe("not_configured");
    expect(classifyFailure(v({ status: "error", reason: "Sandbox unavailable" }), [])).toBe("environment");
  });
});

describe("fingerprint", () => {
  it("ignores timings, ANSI, paths and numbers", () => {
    const a = "\u001b[31mFAIL\u001b[0m /tmp/x1/src/a.test.ts 12ms\nexpected 3 got 4 (1.23s)";
    const b = "\u001b[31mFAIL\u001b[0m /home/u/y2/src/a.test.ts 340ms\nexpected 5 got 6 (0.4s)";
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("differs for a different failure", () => {
    expect(fingerprint("FAIL a")).not.toBe(fingerprint("FAIL b"));
  });
});
