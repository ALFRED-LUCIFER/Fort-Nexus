import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { Markdown, parseMarkdown } from "./Markdown.tsx";

// The issue body NEXUS drafts (escaped by the API's neutraliser) plus hostile input: structure is shown, never HTML.
const ISSUE = [
  "Add a `typecheck` script. Ask @\u200Balice, see https:\u200B//example.com &lt;b&gt;",
  "Second line of the same paragraph with \\*literal\\* stars and **bold**.",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] `npm run typecheck` exits 0",
  "- [x] CI runs it",
  "",
  "```sh",
  "npm run typecheck <b>not html</b>",
  "```",
  "",
  "1. first",
  "2. second",
  "",
  "> quoted",
  "",
  "---",
  "",
  "<img src=x onerror=alert(1)> [click](javascript:alert(1)) <!-- nexus:job-draft:x -->",
].join("\n");

describe("parseMarkdown", () => {
  it("splits blocks: paragraph lines, headings, task lists, fences, ordered lists, quotes and rules", () => {
    expect(parseMarkdown(ISSUE).map((b) => b.kind)).toEqual([
      "paragraph",
      "heading",
      "list",
      "code",
      "list",
      "quote",
      "rule",
      "paragraph",
    ]);
    expect(parseMarkdown(ISSUE)[2]).toEqual({
      kind: "list",
      ordered: false,
      items: [
        { text: "`npm run typecheck` exits 0", task: false, indent: 0 },
        { text: "CI runs it", task: true, indent: 0 },
      ],
    });
  });

  it("closes an unclosed fence at the end and drops HTML comments", () => {
    expect(parseMarkdown("```\ncode <!-- hidden -->\n")).toEqual([
      { kind: "code", lang: "", text: "code \n" },
    ]);
  });
});

describe("Markdown", () => {
  it("renders readable structure as React elements and never as HTML", () => {
    const { container } = render(<Markdown text={ISSUE} />);
    expect(screen.getByRole("heading", { level: 4, name: "Acceptance criteria" })).toBeTruthy();
    const [tasks, ordered] = screen.getAllByRole("list");
    expect(
      within(tasks!)
        .getAllByRole("checkbox")
        .map((c) => (c as HTMLInputElement).checked),
    ).toEqual([false, true]);
    expect(
      within(ordered!)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["first", "second"]);
    expect(screen.getByText("npm run typecheck", { selector: "code" })).toBeTruthy();
    expect(screen.getByLabelText("sh code").textContent).toBe("npm run typecheck <b>not html</b>");
    expect(screen.getByText("bold").tagName).toBe("STRONG");

    const first = container.querySelector("p")!;
    expect(first.querySelector("br")).not.toBeNull(); // a single line break stays a line break
    expect(first.textContent).toContain("https:\u200B//example.com <b>");
    expect(first.textContent).toContain("*literal* stars");

    // Nothing from the text became an element: no image, no link, no bold tag from the code block or entities.
    expect(container.querySelector("img, a, b, script")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain("click (javascript:alert(1))");
    expect(container.textContent).not.toContain("nexus:job-draft");
  });
});
