// FR-GH-08: pull acceptance criteria out of an issue body (GitHub Markdown). First match wins:
// 1. an "Acceptance criteria" heading (or bold / "label:" line) section: its list items, else its lines;
// 2. checkbox list items anywhere;
// 3. Given/When/Then lines, one criterion per scenario.
// An empty result means the issue is missing acceptance criteria.

const MAX_ITEMS = 50;
const MAX_LEN = 500;

const AC_TITLE =
  /^\s*(?:#{1,6}\s*|\*\*|__)?\s*acceptance[\s-]+criteria\s*:?\s*(?:\*\*|__)?\s*:?\s*(?:#+\s*)?$/i;
const HEADING = /^\s*#{1,6}\s+\S/;
const BOLD_TITLE = /^\s*(?:\*\*|__)[^*_]+(?:\*\*|__)\s*:?\s*$/;
const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/;
const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+(.+)$/;
const GWT = /^\s*(?:[-*+]\s+)?(given|when|then|and|but)\b\s*(.*)$/i;

/** Removes HTML comments (issue-template hints) so they are neither shown nor extracted. */
export const stripHtmlComments = (s: string) => s.replace(/<!--[\s\S]*?(?:-->|$)/g, "");

const clean = (items: string[]) =>
  items
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
    .map((s) => (s.length > MAX_LEN ? `${s.slice(0, MAX_LEN - 1)}…` : s));

export function extractAcceptanceCriteria(body: string): string[] {
  const lines = stripHtmlComments(body).split(/\r?\n/);

  const start = lines.findIndex((l) => AC_TITLE.test(l));
  if (start !== -1) {
    const section: string[] = [];
    for (const l of lines.slice(start + 1)) {
      if (HEADING.test(l) || BOLD_TITLE.test(l)) break;
      section.push(l);
    }
    const items = section.flatMap((l) => LIST_ITEM.exec(l)?.[1] ?? []);
    const found = clean(items.length ? items : section.filter((l) => !FENCE.test(l)));
    if (found.length) return found;
  }

  const boxes = clean(lines.flatMap((l) => CHECKBOX.exec(l)?.[1] ?? []));
  if (boxes.length) return boxes;

  const scenarios: string[] = [];
  let current: string[] = [];
  let hasThen = false;
  const flush = () => {
    if (current.length) scenarios.push(current.join(" "));
    current = [];
    hasThen = false;
  };
  for (const l of lines) {
    const m = GWT.exec(l);
    if (!m) {
      flush();
      continue;
    }
    const keyword = m[1]!.toLowerCase();
    // "And"/"But" only continue a scenario; a new "Given" after a "Then" starts the next one.
    if (!current.length && (keyword === "and" || keyword === "but")) continue;
    if (keyword === "given" && hasThen) flush();
    if (keyword === "then") hasThen = true;
    current.push(l.trim().replace(/^[-*+]\s+/, ""));
  }
  flush();
  // Plain prose that happens to start with "When" is not a scenario: require a Then.
  return clean(scenarios.filter((s) => /\bthen\b/i.test(s)));
}
