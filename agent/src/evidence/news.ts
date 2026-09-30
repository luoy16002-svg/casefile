import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Asset, Exhibit, NewsItem } from "../types.js";
import { fetchExhibit, type EvidenceOptions } from "./http.js";

export const NEWS_SOURCES = [
  { source: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { source: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { source: "Decrypt", url: "https://decrypt.co/feed" }
] as const;
const assetWords: Record<Asset, RegExp> = { BTC: /\b(bitcoin|btc)\b/i, ETH: /\b(ethereum|ether|eth)\b/i, SOL: /\b(solana|sol)\b/i };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const text = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value === "object" && value !== null && "#text" in value) return text(value["#text"]);
  return "";
};

export function normalizeNews(raw: string, asset: Asset, source: string, now: number): NewsItem[] {
  if (XMLValidator.validate(raw) !== true) throw new Error("Invalid RSS XML");
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: true });
  const parsed = parser.parse(raw) as { rss?: { channel?: { item?: unknown } } };
  if (!parsed.rss?.channel) throw new Error("RSS channel missing");
  const items = parsed.rss.channel.item;
  const rows = (Array.isArray(items) ? items : items === undefined ? [] : [items]) as Record<string, unknown>[];
  const kept = new Map<string, NewsItem>();
  for (const row of rows) {
    const title = text(row.title).replace(/\s+/g, " ");
    const link = text(row.link);
    const time = Date.parse(text(row.pubDate));
    if (!assetWords[asset].test(title) || !Number.isFinite(time) || time < now - 48 * 3600_000 || time > now) continue;
    if (!/^https?:\/\//i.test(link)) continue;
    const item = { title, link, pubDate: new Date(time).toISOString(), source };
    kept.set(JSON.stringify(item), item);
  }
  return [...kept.values()].sort((a, b) => compare(a.pubDate, b.pubDate) || compare(a.title, b.title) || compare(a.link, b.link));
}

export function fetchNews(asset: Asset, source: typeof NEWS_SOURCES[number], id: string, options: EvidenceOptions = {}): Promise<Exhibit> {
  const now = options.now ?? Date.now();
  return fetchExhibit({ id, kind: "news", ...source, method: "GET" }, raw => normalizeNews(raw, asset, source.source, now), options);
}
