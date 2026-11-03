// Untrusted (model, web or pasted) text made safe for a GitHub issue NEXUS creates: nothing in it can mention
// anyone, reference an issue, autolink, add HTML or forge one of NEXUS's hidden markers.

const ZW = "​";
const CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu; // controls, bidi overrides and zero-width characters
// The same, but keeps the zero-width spaces the rules below insert: text neutralised before stays exactly as it is.
const CONTROLS_BUT_ZW = /(?!\u200B)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const unlinked = (text: string, controls: RegExp) =>
  text
    .replace(controls, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/@(?=[\p{L}\p{N}_-])/gu, `@${ZW}`)
    .replace(/#(?=\d)/g, `#${ZW}`)
    .replace(/\bGH-(?=\d)/gi, (m) => `${m.slice(0, 2)}${ZW}-`)
    .replace(/:\/\//g, `:${ZW}//`)
    .replace(/\bwww\./gi, (m) => `${m.slice(0, 3)}${ZW}.`);

/** Single-line plain text with no @mentions, issue references or autolinks (titles aren't Markdown). */
export const inertTitle = (text: string) => unlinked(text, CONTROLS);

/**
 * Untrusted (model or web) text as inert Markdown: one line, Markdown and HTML syntax escaped, so it can't add links,
 * images, headings, HTML or a fake marker, and none of the mentions, references or autolinks GitHub would make.
 */
export const inert = (text: string) =>
  inertTitle(text.replace(/[\\`*_[\]&|~]/g, "\\$&"))
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** `inertTitle` for text the owner edits after NEXUS neutralised it: the same rules, idempotent. */
export const reinertTitle = (text: string) => unlinked(text, CONTROLS_BUT_ZW);

/** `inert`'s escaping, leaving what is already escaped (`\*`, `&lt;`) as it is. */
const inertLine = (text: string) =>
  reinertTitle(
    text.replace(/\\[\\`*_[\]&|~]|&(?:lt|gt);|[\\`*_[\]&|~]/g, (m) => (m.length > 1 ? m : `\\${m}`)),
  )
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

// A heading, checkbox, bullet or numbered item at the start of a line: the only Markdown structure inertLines keeps.
const STRUCTURE = /^\s{0,6}(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d{1,3}[.)]\s+)?(.*)$/;

/**
 * Multi-line Markdown the owner edited (e.g. a drafted issue body): each line keeps its heading, list or checkbox
 * prefix and everything else on it is neutralised like `inert`. Applying it to its own output changes nothing, so
 * editing one word never re-escapes the rest. Runs of blank lines collapse to one.
 */
export const inertLines = (text: string) =>
  text
    .split(/\r?\n|[\r\p{Zl}\p{Zp}]/u)
    .map((line) => {
      const [, prefix = "", rest = ""] = STRUCTURE.exec(line) ?? [];
      const body = inertLine(rest);
      return body ? `${prefix.replace(/\s+/g, " ").trimEnd()} ${body}`.trimStart() : "";
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
