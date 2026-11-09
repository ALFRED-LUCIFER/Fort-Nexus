import type { ChangesetFile } from "@nexus/contracts";
import { describe, expect, it } from "vitest";
import { checkIntegrity } from "./integrity.ts";

const file = (path: string, text: string, change: "added" | "modified" = "modified"): ChangesetFile => ({
  change,
  path,
  mode: "100644",
  contentBase64: Buffer.from(text).toString("base64"),
});
const del = (path: string): ChangesetFile => ({ change: "deleted", path });
const baseOf = (files: Record<string, string>) => async (p: string) => files[p] ?? null;
const none = baseOf({});

describe("checkIntegrity", () => {
  it("is clean for ordinary source changes and reports no test files", async () => {
    const r = await checkIntegrity([file("src/a.ts", "x")], none);
    expect(r).toEqual({ clean: true, problems: [], testFilesChanged: [] });
  });
  it("lists edited test files without flagging them", async () => {
    const r = await checkIntegrity(
      [file("src/a.test.ts", "it('a',()=>{})")],
      baseOf({ "src/a.test.ts": "it('b',()=>{})" }),
    );
    expect(r.clean).toBe(true);
    expect(r.testFilesChanged).toEqual(["src/a.test.ts"]);
  });
  it("flags a deleted test file", async () => {
    const r = await checkIntegrity([del("src/a.test.ts")], none);
    expect(r.clean).toBe(false);
    expect(r.problems).toEqual(["Deleted test file src/a.test.ts"]);
    expect(r.testFilesChanged).toEqual(["src/a.test.ts"]);
  });
  it("recognises test paths and names", async () => {
    for (const p of [
      "__tests__/x.ts",
      "a/test/x.ts",
      "tests/x.py",
      "spec/x.rb",
      "a.spec.js",
      "a_test.go",
      "test_a.py",
      "FooTest.java",
      "FooTests.cs",
    ]) {
      expect((await checkIntegrity([del(p)], none)).clean, p).toBe(false);
    }
    expect((await checkIntegrity([del("src/latest.ts")], none)).clean).toBe(true);
  });
  it("flags a changed test script but not dependencies", async () => {
    const before = JSON.stringify({ scripts: { test: "vitest run" }, dependencies: { a: "1" } });
    const bad = JSON.stringify({ scripts: { test: "true" }, dependencies: { a: "1" } });
    const ok = JSON.stringify({ scripts: { test: "vitest run" }, dependencies: { a: "2", b: "1" } });
    const b = baseOf({ "package.json": before });
    expect((await checkIntegrity([file("package.json", bad)], b)).clean).toBe(false);
    expect((await checkIntegrity([file("package.json", ok)], b)).clean).toBe(true);
    expect((await checkIntegrity([file("package.json", bad.replace("true", "vitest"))], b)).clean).toBe(
      false,
    );
  });
  it("flags jest or vitest keys in package.json", async () => {
    const b = baseOf({ "package.json": JSON.stringify({ jest: { bail: 0 } }) });
    expect(
      (await checkIntegrity([file("package.json", JSON.stringify({ jest: { bail: 1 } }))], b)).clean,
    ).toBe(false);
  });
  it("flags skip and focus markers", async () => {
    for (const m of [
      "it.only('a',()=>{})",
      "describe.skip('a',()=>{})",
      "xit('a',()=>{})",
      "fdescribe('a',()=>{})",
      "@Ignore\nvoid a(){}",
      "@pytest.mark.skip\ndef test_a(): pass",
      "test.skip('a',()=>{})",
      "xdescribe('a',()=>{})",
      "it.skipIf(c)('a',()=>{})",
      't.Skipf("x")',
      'b.Skip("x")',
      "it.todo('a')",
      "test.fixme('a')",
      'pytest.skip("x")',
      'pytest.importorskip("x")',
      'self.skipTest("x")',
      "it.skip.each([1])('a',()=>{})",
    ]) {
      const r = await checkIntegrity([file("src/a.test.ts", `ok\n${m}`)], baseOf({ "src/a.test.ts": "ok" }));
      expect(r.clean, m).toBe(false);
    }
  });
  it("does not count ordinary property access", async () => {
    for (const t of ["expect(result.skipped).toBe(0)", "this.todo = []", "const only = x.only;"]) {
      const r = await checkIntegrity([file("a.test.ts", `ok\n${t}`)], baseOf({ "a.test.ts": "ok" }));
      expect(r.clean, t).toBe(true);
    }
  });
  it("ignores a marker that already existed at base, flags an extra one", async () => {
    const b = baseOf({ "a.test.ts": "it.skip('a',()=>{})" });
    expect((await checkIntegrity([file("a.test.ts", "it.skip('a',()=>{})\n// edit")], b)).clean).toBe(true);
    expect(
      (await checkIntegrity([file("a.test.ts", "it.skip('a',()=>{})\nit.skip('b',()=>{})")], b)).clean,
    ).toBe(false);
  });
  it("allows no marker at all in a new test file", async () => {
    expect((await checkIntegrity([file("new.test.ts", "it.skip('a',()=>{})", "added")], none)).clean).toBe(
      false,
    );
    expect((await checkIntegrity([file("new.test.ts", "it('a',()=>{})", "added")], none)).clean).toBe(true);
  });
  it("flags .nexus.json and runner configs", async () => {
    for (const p of [
      ".nexus.json",
      "vitest.config.ts",
      "vitest.workspace.ts",
      "jest.config.js",
      "apps/web/playwright.config.ts",
      "karma.conf.js",
      "pytest.ini",
      ".mocharc.json",
      "phpunit.xml",
      "phpunit.xml.dist",
      "conftest.py",
    ]) {
      const r = await checkIntegrity([file(p, "changed")], baseOf({ [p]: "orig" }));
      expect(r.clean, p).toBe(false);
    }
    expect(
      (await checkIntegrity([file("vitest.config.ts", "same")], baseOf({ "vitest.config.ts": "same" })))
        .clean,
    ).toBe(true);
    expect((await checkIntegrity([del(".nexus.json")], baseOf({ ".nexus.json": "{}" }))).clean).toBe(false);
  });
  it("compares only the pytest section of pyproject.toml", async () => {
    const b = baseOf({ "pyproject.toml": "[project]\nname='a'\n[tool.pytest.ini_options]\naddopts='-q'\n" });
    expect(
      (
        await checkIntegrity(
          [file("pyproject.toml", "[project]\nname='b'\n[tool.pytest.ini_options]\naddopts='-q'\n")],
          b,
        )
      ).clean,
    ).toBe(true);
    expect(
      (
        await checkIntegrity(
          [file("pyproject.toml", "[project]\nname='a'\n[tool.pytest.ini_options]\naddopts='-q --co'\n")],
          b,
        )
      ).clean,
    ).toBe(false);
  });
  it("skips binary content and caps problems", async () => {
    const bin: ChangesetFile = {
      change: "modified",
      path: "a.test.ts",
      mode: "100644",
      contentBase64: Buffer.from([0xff, 0xfe, 0x00, 0x80]).toString("base64"),
    };
    expect((await checkIntegrity([bin], baseOf({ "a.test.ts": "x" }))).clean).toBe(true);
    const many = Array.from({ length: 80 }, (_, i) => del(`t/${"x".repeat(300)}${i}.test.ts`));
    const r = await checkIntegrity(many, none);
    expect(r.problems.length).toBe(50);
    expect(r.problems.every((p) => p.length < 200)).toBe(true);
  });
});
