import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { FetchSession, Skip } from "../fetch.ts";

// FR-RES-05/06: a web page as readable text for the deep-dive loop and claim verification. The text is untrusted
// data: it is only ever stored and shown as text, and handed to the model inside the untrusted-data fence.

export const MAX_PAGE_TEXT = 200_000;
const MAX_TITLE = 300;
const PAGE_ACCEPT = "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1";
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

export type PageResult = { ok: true; finalUrl: URL; title: string; text: string; sha256: string } | Skip;

// Elements whose content is never page text, and those that end a line of it.
const SKIP = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "SVG",
  "IFRAME",
  "OBJECT",
  "HEAD",
  "BUTTON",
]);
const BLOCK = new Set(
  (
    "ADDRESS ARTICLE ASIDE BLOCKQUOTE BR DD DIV DL DT FIGCAPTION FIGURE FOOTER FORM H1 H2 H3 H4 H5 H6 HEADER HR LI " +
    "MAIN NAV OL P PRE SECTION TABLE TD TH TR UL"
  ).split(" "),
);

type TextNode = {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<TextNode>;
};

/** Visible text with a line break around block elements (iterative: a deeply nested page can't blow the stack). */
function blockText(root: TextNode): string {
  const out: string[] = [];
  const stack: (TextNode | "\n")[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === "\n") {
      out.push("\n");
      continue;
    }
    if (node.nodeType === 3) out.push(node.nodeValue ?? "");
    else if (node.nodeType === 1 || node.nodeType === 9 || node.nodeType === 11) {
      const name = node.nodeName.toUpperCase();
      if (SKIP.has(name)) continue;
      const block = BLOCK.has(name);
      if (block) stack.push("\n");
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
      if (block) out.push("\n");
    }
  }
  return tidy(out.join(""));
}

/** Spaces collapsed within lines, blank-line runs collapsed to one paragraph break. */
const tidy = (s: string) =>
  s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function readHtml(html: string, url: URL): { title: string; text: string } {
  const parse = () => parseHTML(html).document;
  const doc = parse();
  const docTitle = doc.title ?? "";
  let article: { title?: string | null; content?: TextNode | null } | null = null;
  try {
    // Readability mutates the document; the fallback below parses a fresh one.
    article = new Readability<TextNode>(doc as unknown as ConstructorParameters<typeof Readability>[0], {
      serializer: (node) => node as unknown as TextNode,
    }).parse();
  } catch {
    article = null; // hostile or broken markup: fall back to the whole body
  }
  let text = article?.content ? blockText(article.content) : "";
  if (!text) {
    const fresh = parse();
    text = blockText((fresh.body ?? fresh.documentElement) as unknown as TextNode);
  }
  const title = (article?.title || docTitle).replace(/\s+/g, " ").trim() || url.hostname;
  return { title, text };
}

/**
 * Fetches `url` through the research fetch session (SSRF guard, robots.txt, limits) and returns its readable text.
 * HTML goes through Readability; text/plain is kept as is; feeds, PDFs, images and anything else are
 * UNSUPPORTED_TYPE. `sha256` is over the returned (capped) text.
 */
export async function readPage(get: FetchSession["get"], url: URL): Promise<PageResult> {
  const res = await get(url, PAGE_ACCEPT);
  if (!res.ok) return res;
  let read: { title: string; text: string };
  if (HTML_TYPES.has(res.contentType)) read = readHtml(res.body, res.url);
  else if (res.contentType === "text/plain")
    read = { title: res.url.pathname.split("/").pop() || res.url.hostname, text: tidy(res.body) };
  else
    return {
      ok: false,
      reason: "UNSUPPORTED_TYPE",
      detail: `Not a readable page (${res.contentType || "no content type"})`,
    };
  if (!read.text) return { ok: false, reason: "UNSUPPORTED_TYPE", detail: "The page has no readable text" };
  const text = read.text.slice(0, MAX_PAGE_TEXT);
  return {
    ok: true,
    finalUrl: res.url,
    title: read.title.slice(0, MAX_TITLE),
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}
