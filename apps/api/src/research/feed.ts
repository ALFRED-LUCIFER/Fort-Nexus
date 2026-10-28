import { XMLParser } from "fast-xml-parser";

export type FeedItem = { title: string; link: URL; excerpt: string; publishedAt: Date | null };

const MAX_ITEMS = 200;
const MAX_TITLE = 500;
export const MAX_EXCERPT = 1000;

// Entity expansion stays within fast-xml-parser's default limits; there are no external entities to resolve.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  htmlEntities: true,
  isArray: (name) => name === "item" || name === "entry" || name === "link",
});

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? m;
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });

/** Feed text (often escaped HTML) as plain text: scripts/styles dropped, tags removed, entities decoded. */
export const plainText = (s: string, max: number) =>
  decode(s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

// A parsed node: a string, `{ "#text": … }` when it has attributes, or an array of either.
const text = (v: unknown): string => {
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "#text" in v) return String(v["#text"]);
  return "";
};

const date = (v: unknown) => {
  const t = Date.parse(text(v));
  return Number.isNaN(t) ? null : new Date(t);
};

// Item links are untrusted: only absolute http(s) links (resolved against the feed) are kept, never javascript: etc.
const link = (href: string, base: URL) => {
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
};

type Node = Record<string, unknown>;

const atomLink = (links: unknown) => {
  const all = (Array.isArray(links) ? links : []) as Node[];
  const alt = all.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? all[0];
  return alt ? String(alt["@_href"] ?? "") : "";
};

/** RSS 2.0 or Atom items in feed order; null when the body isn't one of those formats. */
export function parseFeed(xml: string, base: URL): FeedItem[] | null {
  let doc: Node;
  try {
    doc = parser.parse(xml, true) as Node;
  } catch {
    return null;
  }
  const rss = (doc.rss as Node | undefined)?.channel as Node | undefined;
  const atom = doc.feed as Node | undefined;
  if (!rss && !atom) return null;
  const raw = ((rss ? rss.item : atom!.entry) ?? []) as Node[];

  const items: FeedItem[] = [];
  for (const it of raw.slice(0, MAX_ITEMS)) {
    const href = rss
      ? text(it.link) || (text(it.guid).startsWith("http") ? text(it.guid) : "")
      : atomLink(it.link);
    const url = href ? link(href, base) : null;
    const title = plainText(text(it.title), MAX_TITLE);
    if (!url || !title) continue;
    items.push({
      title,
      link: url,
      excerpt: plainText(
        text(rss ? (it.description ?? it["content:encoded"]) : (it.summary ?? it.content)),
        MAX_EXCERPT,
      ),
      publishedAt: rss ? date(it.pubDate) : date(it.published ?? it.updated),
    });
  }
  return items;
}
