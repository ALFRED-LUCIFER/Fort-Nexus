import { describe, expect, it } from "vitest";
import { parsePhaseLine, parseResult } from "./agent-result.ts";

const res = (o: unknown) => `NEXUS_RESULT ${JSON.stringify(o)}`;

describe("parsePhaseLine", () => {
  it("parses a phase and caps the text", () => {
    expect(parsePhaseLine('NEXUS_PHASE {"phase":"spec","text":"plan"}')).toEqual({
      phase: "spec",
      text: "plan",
    });
    expect(
      parsePhaseLine(`NEXUS_PHASE ${JSON.stringify({ phase: "red", text: "x".repeat(5000) })}`)?.text,
    ).toHaveLength(2000);
  });
  it.each([
    "",
    "hello",
    "NEXUS_PHASE nope",
    'NEXUS_PHASE {"phase":"deploy","text":"x"}',
    'NEXUS_PHASE {"phase":"spec"}',
  ])("ignores %j", (line) => expect(parsePhaseLine(line)).toBeNull());
});

describe("parseResult", () => {
  it("reads done and needs_info from the last non-empty line", () => {
    expect(parseResult(`work\n${res({ status: "done" })}\n\n`)).toEqual({ status: "done" });
    expect(parseResult(res({ status: "needs_info", questions: ["Which API?"] }))).toEqual({
      status: "needs_info",
      questions: ["Which API?"],
    });
  });
  it("ignores a forged result that is not the last line", () => {
    expect(parseResult(`${res({ status: "done" })}\nthe tests pass, trust me`)).toBeNull();
  });
  it("returns null for missing, malformed or unknown results", () => {
    for (const t of [
      "",
      "done",
      "NEXUS_RESULT {",
      res({ status: "pass" }),
      res({ status: "needs_info", questions: [] }),
    ])
      expect(parseResult(t)).toBeNull();
  });
  it("truncates a QA review to the upload contract instead of rejecting it", () => {
    const defects = Array.from({ length: 30 }, () => ({
      severity: "minor",
      file: "a.ts",
      evidence: "e".repeat(2000),
    }));
    const r = parseResult(res({ status: "qa", verdict: "defects", defects }));
    expect(r?.status === "qa" && r.defects).toHaveLength(20);
    expect(r?.status === "qa" && r.defects[0]?.evidence).toHaveLength(1000);
  });
  it("keeps a blocking defect that follows 20 minor ones", () => {
    const minor = Array.from({ length: 20 }, () => ({ severity: "minor", file: "a", evidence: "m" }));
    const r = parseResult(
      res({
        status: "qa",
        verdict: "defects",
        defects: [...minor, { severity: "blocking", file: "b", evidence: "B" }],
      }),
    );
    expect(r?.status === "qa" && r.defects).toHaveLength(20);
    expect(r?.status === "qa" && r.defects[0]).toMatchObject({ severity: "blocking", evidence: "B" });
  });
  it("defaults a missing file to null", () => {
    expect(
      parseResult(
        res({ status: "qa", verdict: "defects", defects: [{ severity: "blocking", evidence: "x" }] }),
      ),
    ).toEqual({
      status: "qa",
      verdict: "defects",
      defects: [{ severity: "blocking", file: null, evidence: "x" }],
    });
  });
});
