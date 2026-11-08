import { describe, expect, it } from "vitest";
import { inert, inertLines, inertTitle } from "../src/github/issue-text.ts";

// Untrusted text for GitHub issues: code stays code (no backslashes before backticks), and nothing outside or inside
// it can mention, reference, autolink, add HTML or spell an HTML comment.
const ZW = "\u200B";
const mentionsOrLinks = /@[\p{L}\p{N}_-]|#\d|:\/\/|www\.|<!--|<img/u;

describe("inert (one line)", () => {
  it("keeps inline code spans as written and escapes the Markdown around them", () => {
    expect(inert("Run `tsc --noEmit` and *then* ``a ` b`` [x]")).toBe(
      "Run `tsc --noEmit` and \\*then\\* ``a ` b`` \\[x\\]",
    );
    // An unmatched backtick isn't code: it is escaped.
    expect(inert("half `open")).toBe("half \\`open");
  });

  it("neutralises mentions, references, links and comments inside code spans too", () => {
    const out = inert(
      "Ask @alice about #5 at https://evil.example `@bob #6 www.x.io <!-- m -->` <img src=x>",
    );
    expect(out).not.toMatch(mentionsOrLinks);
    expect(out).toContain(`\`@${ZW}bob #${ZW}6 www${ZW}.x.io <${ZW}!-- m -->\``);
    expect(out).toContain("&lt;img src=x&gt;");
  });
});

describe("inertLines (multi-line Markdown)", () => {
  const body = [
    "## Context",
    "",
    "Add a `typecheck` script that runs `tsc --noEmit`; ping @alice, see https://example.com/x.",
    "",
    "",
    "```bash ignored info",
    "pnpm run typecheck   # @carol #12",
    "\techo `done` <b>x</b>",
    "```",
    "",
    "- [ ] `pnpm typecheck` exits 0",
    "1. Then *this*",
  ].join("\n");

  it("keeps headings, lists, inline code and fenced blocks; neutralises everything else", () => {
    const out = inertLines(body);
    expect(out).toBe(
      [
        "## Context",
        "",
        `Add a \`typecheck\` script that runs \`tsc --noEmit\`; ping @${ZW}alice, see https:${ZW}//example.com/x.`,
        "",
        "```bash",
        `pnpm run typecheck   # @${ZW}carol #${ZW}12`,
        "    echo `done` <b>x</b>",
        "```",
        "",
        "- [ ] `pnpm typecheck` exits 0",
        "1. Then \\*this\\*",
      ].join("\n"),
    );
    expect(out).not.toMatch(/\\`/);
    expect(out).not.toMatch(mentionsOrLinks);
  });

  it("is idempotent, closes an unclosed fence and breaks a forged marker anywhere", () => {
    const once = inertLines(body);
    expect(inertLines(once)).toBe(once);
    const open = inertLines("Intro\n~~~\n<!-- nexus:job-draft:x -->\n@dave");
    expect(open).toBe(`Intro\n~~~\n<${ZW}!-- nexus:job-draft:x -->\n@${ZW}dave\n~~~`);
    expect(inertLines(open)).toBe(open);
    expect(inertLines("a <!-- nexus:job-draft:x --> b")).toBe(`a &lt;${ZW}!-- nexus:job-draft:x --&gt; b`);
  });

  it("leaves text escaped by an earlier version as it is", () => {
    expect(inertLines("Run \\`tsc\\` now")).toBe("Run \\`tsc\\` now");
  });
});

describe("inertTitle", () => {
  it("is plain text: backticks are kept, links and mentions broken", () => {
    expect(inertTitle("Add `typecheck` for @x #3")).toBe(`Add \`typecheck\` for @${ZW}x #${ZW}3`);
  });
});
