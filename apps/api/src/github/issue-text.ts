// Untrusted (model, web or pasted) text made safe for a GitHub issue NEXUS creates: nothing in it can mention
// anyone, reference an issue, autolink, add HTML or forge one of NEXUS's hidden markers.
//
// Code spans and fenced code blocks are kept as code: GitHub renders their content literally (no Markdown, HTML,
// mentions, references or autolinks), so Markdown-escaping it would only show backslashes. Their content still gets
// the invisible zero-width breaks below and can't spell an HTML comment, so the guarantee doesn't rest on GitHub's
// parser agreeing with ours.

const ZW = "​";
const CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu; // controls, bidi overrides and zero-width characters
// The same, but keeps the zero-width spaces the rules below insert: text neutralised before stays exactly as it is.
const CONTROLS_BUT_ZW = /(?!\u200B)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Zero-width breaks: no @mention, issue reference, GH- reference, autolink or HTML comment survives. */
const unlinkedText = (text: string) =>
  text
    .replace(/@(?=[\p{L}\p{N}_-])/gu, `@${ZW}`)
    .replace(/#(?=\d)/g, `#${ZW}`)
    .replace(/\bGH-(?=\d)/gi, (m) => `${m.slice(0, 2)}${ZW}-`)
    .replace(/:\/\//g, `:${ZW}//`)
    .replace(/\bwww\./gi, (m) => `${m.slice(0, 3)}${ZW}.`)
    .replaceAll("<!--", `<${ZW}!--`);

const oneLine = (text: string, controls: RegExp) => text.replace(controls, " ").replace(/\s+/g, " ").trim();

const unlinked = (text: string, controls: RegExp) => unlinkedText(oneLine(text, controls));

/** Single-line plain text with no @mentions, issue references or autolinks (titles aren't Markdown). */
export const inertTitle = (text: string) => unlinked(text, CONTROLS);

/** `inertTitle` for text the owner edits after NEXUS neutralised it: the same rules, idempotent. */
export const reinertTitle = (text: string) => unlinked(text, CONTROLS_BUT_ZW);

// A code span on one line (CommonMark): a backtick run that isn't escaped, its content, then a run of exactly the
// same length. Backslashes inside a code span are literal, so the closing run may follow one.
const CODE_SPAN = /(?<![`\\])(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;

/** `outside` for the text around code spans, `unlinkedText` for the spans themselves (kept as written). */
function aroundCode(line: string, outside: (s: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(CODE_SPAN)) {
    out += outside(line.slice(last, m.index)) + unlinkedText(m[0]);
    last = m.index + m[0].length;
  }
  return out + outside(line.slice(last));
}

const html = (s: string) => s.replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Untrusted (model or web) text as inert Markdown: one line, Markdown and HTML syntax escaped outside code spans, so it
 * can't add links, images, headings, HTML or a fake marker, and none of the mentions, references or autolinks GitHub
 * would make.
 */
export const inert = (text: string) =>
  aroundCode(oneLine(text, CONTROLS), (s) => html(unlinkedText(s.replace(/[\\`*_[\]&|~]/g, "\\$&"))));

/** `inert`'s escaping, leaving what is already escaped (`\*`, `&lt;`) and what is already neutralised as it is. */
const inertLine = (text: string) =>
  aroundCode(oneLine(text, CONTROLS_BUT_ZW), (s) =>
    html(
      unlinkedText(
        s.replace(/\\[\\`*_[\]&|~]|&(?:lt|gt);|[\\`*_[\]&|~]/g, (m) => (m.length > 1 ? m : `\\${m}`)),
      ),
    ),
  );

// A heading, checkbox, bullet or numbered item at the start of a line: the only Markdown structure inertLines keeps.
const STRUCTURE = /^\s{0,6}(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d{1,3}[.)]\s+)?(.*)$/;
// A code fence (CommonMark): 3+ backticks or tildes, indented at most 3 spaces, then an info string.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** A line inside a fenced code block: indentation kept, controls and links neutralised, no Markdown escaping. */
const codeLine = (line: string) =>
  unlinkedText(line.replaceAll("\t", "    ").replace(CONTROLS_BUT_ZW, " ").trimEnd());

/**
 * Multi-line Markdown (a drafted issue body, the owner's edit of it): each line keeps its heading, list or checkbox
 * prefix and everything else on it is neutralised like `inert`; inline code spans and fenced code blocks stay code.
 * Applying it to its own output changes nothing, so editing one word never re-escapes the rest. Runs of blank lines
 * collapse to one outside code; an unclosed fence is closed so it can't swallow what NEXUS appends after it.
 */
export function inertLines(text: string): string {
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split(/\r?\n|[\r\p{Zl}\p{Zp}]/u)) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence.char && f[1]!.length >= fence.length && f[2]!.trim() === "") {
        out.push(fence.char.repeat(fence.length));
        fence = null;
      } else out.push(codeLine(line));
      continue;
    }
    // A backtick fence's info string can't hold a backtick; only a plain language name is kept.
    if (f && !(f[1]![0] === "`" && f[2]!.includes("`"))) {
      fence = { char: f[1]![0]!, length: f[1]!.length };
      out.push(`${f[1]}${/^\s*([\w+-]{1,30})/.exec(f[2]!)?.[1] ?? ""}`);
      continue;
    }
    const [, prefix = "", rest = ""] = STRUCTURE.exec(line) ?? [];
    const body = inertLine(rest);
    const kept = body ? `${prefix.replace(/\s+/g, " ").trimEnd()} ${body}`.trimStart() : "";
    if (kept || out.at(-1) !== "") out.push(kept);
  }
  if (fence) out.push(fence.char.repeat(fence.length));
  return out.join("\n").trim();
}

/** Untrusted text inside a fence longer than any backtick run in it: no @mentions, links or closing keywords. */
export const fenced = (text: string) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
};
