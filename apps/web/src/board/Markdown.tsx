import { Fragment, type ReactNode } from "react";

// Untrusted Markdown (GitHub issue bodies and comments, an agent's report) shown readably and safely: a small subset
// is turned into React elements, so React escapes every character and nothing is ever parsed as HTML. Links stay
// text (their target is shown, never followed from here), images and raw HTML stay text, HTML comments are dropped.
//
// Supported: paragraphs (single line breaks kept, as GitHub does in issues), ATX headings, bullet and numbered lists
// with task checkboxes, block quotes, thematic breaks, fenced code blocks, inline code, bold, italic, backslash
// escapes and the HTML entities NEXUS's own neutraliser writes (&lt; &gt; &amp; &quot; &#39;).

export type Block =
  | { kind: "heading"; depth: number; text: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: { text: string; task: boolean | null; indent: number }[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "rule" };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

/** Splits Markdown into blocks. Pure, so it is tested without rendering. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/<!--[\s\S]*?(?:-->|$)/g, "").split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      const [, marker = "", lang = ""] = fence;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]!);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) break;
        body.push(lines[i]!);
        i++;
      }
      i++; // the closing fence (or the end of the text)
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", depth: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }
    if (ITEM.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: Extract<Block, { kind: "list" }>["items"] = [];
      for (
        let m = ITEM.exec(lines[i] ?? "");
        m && /^\s*\d/.test(m[0]) === ordered;
        m = ITEM.exec(lines[i] ?? "")
      ) {
        items.push({
          text: m[4]!,
          task: m[3] === undefined ? null : m[3] !== " ",
          indent: Math.min(3, Math.floor(m[1]!.replace(/\t/g, "    ").length / 2)),
        });
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      for (let m = QUOTE.exec(lines[i] ?? ""); m; m = QUOTE.exec(lines[i] ?? "")) {
        quoted.push(m[1]!);
        i++;
      }
      blocks.push({ kind: "quote", lines: quoted });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (
        l.trim() === "" ||
        FENCE.test(l) ||
        HEADING.test(l) ||
        RULE.test(l) ||
        ITEM.test(l) ||
        QUOTE.test(l)
      )
        break;
      para.push(l.trim());
      i++;
    }
    blocks.push({ kind: "paragraph", lines: para });
  }
  return blocks;
}

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', "#39": "'" };
// One inline token: a code span, a backslash escape, bold, italic, a link or an entity; plain text in between.
const INLINE =
  /(?<!\\)(`+)(?!`)(.+?)(?<!`)\1(?!`)|\\([!-/:-@[-`{-~])|\*\*(?=\S)(.+?)\*\*|__(?=\S)(.+?)__|(?<![\w*])\*(?=\S)(.+?)\*(?![\w*])|(?<![\w_])_(?=\S)(.+?)_(?![\w_])|\[([^\]]+)\]\(([^)\s]+)\)|&(lt|gt|amp|quot|#39);/g;

/** Inline Markdown as React nodes: text only, never HTML. */
export function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}.${n++}`;
    const [, , code, escaped, bold1, bold2, em1, em2, linkText, href, entity] = m;
    if (code !== undefined) {
      // CommonMark: one space of padding on both sides is stripped.
      const c = /^ .*[^ ].* $/.test(code) ? code.slice(1, -1) : code;
      out.push(
        <code key={k} className="rounded-[5px] bg-hair px-1 py-px font-mono text-[0.9em]">
          {c}
        </code>,
      );
    } else if (escaped !== undefined) out.push(escaped);
    else if (bold1 !== undefined || bold2 !== undefined)
      out.push(<strong key={k}>{inline((bold1 ?? bold2)!, k)}</strong>);
    else if (em1 !== undefined || em2 !== undefined) out.push(<em key={k}>{inline((em1 ?? em2)!, k)}</em>);
    else if (linkText !== undefined)
      out.push(
        <Fragment key={k}>
          {inline(linkText, k)}
          <span className="text-ink3"> ({href})</span>
        </Fragment>,
      );
    else out.push(ENTITY[entity!]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const HEADING_SIZE = ["text-[1.15em]", "text-[1.05em]", "text-[1em]"];

/**
 * Markdown as readable, safe React elements. `headingLevel` is the HTML level of a `#` heading inside this text, so
 * its headings fit under the surrounding page's own (deeper `#`s go one level down each, at most h6).
 */
export function Markdown({
  text,
  headingLevel = 3,
  className = "",
}: {
  text: string;
  headingLevel?: 2 | 3 | 4 | 5;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-2.5 break-words ${className}`}>
      {parseMarkdown(text).map((b, n) => {
        const k = `b${n}`;
        switch (b.kind) {
          case "heading": {
            const H = `h${Math.min(6, headingLevel + b.depth - 1)}` as "h2";
            return (
              <H key={k} className={`m-0 font-semibold text-ink ${HEADING_SIZE[Math.min(2, b.depth - 1)]}`}>
                {inline(b.text, k)}
              </H>
            );
          }
          case "paragraph":
            return (
              <p key={k} className="m-0">
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {inline(l, `${k}.${j}`)}
                  </Fragment>
                ))}
              </p>
            );
          case "list": {
            const L = b.ordered ? "ol" : "ul";
            return (
              <L
                key={k}
                className={`m-0 flex flex-col gap-1 pl-5 ${b.ordered ? "list-decimal" : "list-disc"}`}
              >
                {b.items.map((it, j) => (
                  <li
                    key={j}
                    className={it.task === null ? "" : "list-none"}
                    style={it.indent ? { marginLeft: `${it.indent * 1.25}rem` } : undefined}
                  >
                    {it.task !== null && (
                      <input
                        type="checkbox"
                        checked={it.task}
                        readOnly
                        disabled
                        className="mr-2 -ml-5 align-[-2px] accent-teal"
                      />
                    )}
                    {inline(it.text, `${k}.${j}`)}
                  </li>
                ))}
              </L>
            );
          }
          case "quote":
            return (
              <blockquote key={k} className="m-0 border-l-2 border-hair pl-3 text-ink3">
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {inline(l, `${k}.${j}`)}
                  </Fragment>
                ))}
              </blockquote>
            );
          case "code":
            return (
              <pre
                key={k}
                // Scrollable code must be keyboard-reachable (WCAG 2.1.1).
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                tabIndex={0}
                aria-label={b.lang ? `${b.lang} code` : "Code"}
                className="m-0 overflow-auto rounded-xl bg-hair p-3 font-mono text-[0.85em] leading-[1.5] whitespace-pre"
              >
                <code>{b.text}</code>
              </pre>
            );
          case "rule":
            return <hr key={k} className="m-0 w-full border-0 border-t border-hair" />;
        }
      })}
    </div>
  );
}
