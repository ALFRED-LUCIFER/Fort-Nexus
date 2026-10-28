import { describe, expect, it } from "vitest";
import { extractAcceptanceCriteria as extract } from "../src/github/acceptance-criteria.ts";

describe("extractAcceptanceCriteria", () => {
  it("takes the list items of an Acceptance criteria heading section, stopping at the next heading", () => {
    const body = [
      "Intro",
      "### Acceptance Criteria:",
      "1. Totals round per currency",
      "* [ ] No layout shift",
      "",
      "### Notes",
      "- unrelated",
    ].join("\r\n");
    expect(extract(body)).toEqual(["Totals round per currency", "No layout shift"]);
  });

  it("accepts a bold or 'label:' title and falls back to the section's lines", () => {
    expect(extract("**Acceptance criteria**\nLCP under 2.5 s\n\n**Out of scope**\n- other")).toEqual([
      "LCP under 2.5 s",
    ]);
    expect(extract("Acceptance criteria:\n- works offline")).toEqual(["works offline"]);
  });

  it("uses checkbox items anywhere when there is no section", () => {
    expect(extract("Todo\n- [ ] first\n- [x] second\n- plain bullet")).toEqual(["first", "second"]);
  });

  it("groups Given/When/Then lines into one criterion per scenario", () => {
    const body = [
      "```gherkin",
      "Given a cart in EUR",
      "And one item",
      "When the total is shown",
      "Then it has two decimals",
      "Given a cart in JPY",
      "Then it has no decimals",
      "```",
    ].join("\n");
    expect(extract(body)).toEqual([
      "Given a cart in EUR And one item When the total is shown Then it has two decimals",
      "Given a cart in JPY Then it has no decimals",
    ]);
  });

  it("reports nothing for prose, empty bodies and criteria hidden in HTML comments", () => {
    expect(extract("")).toEqual([]);
    expect(extract("When I open the page it is slow. Please fix.")).toEqual([]);
    expect(extract("<!--\n## Acceptance criteria\n- [ ] template hint\n-->\nJust a bug.")).toEqual([]);
    expect(extract("## Acceptance criteria\n\n## Next")).toEqual([]);
  });

  it("caps the number and length of criteria", () => {
    const many = Array.from({ length: 80 }, (_, i) => `- [ ] item ${i}`).join("\n");
    expect(extract(many)).toHaveLength(50);
    const [long] = extract(`- [ ] ${"x".repeat(900)}`);
    expect(long).toHaveLength(500);
    expect(long!.endsWith("…")).toBe(true);
  });
});
