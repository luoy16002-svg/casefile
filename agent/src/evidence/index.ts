import type { Asset, Exhibit } from "../types.js";
import { fetchCandles } from "./coinbase.js";
import { fetchHyperliquid } from "./hyperliquid.js";
import { fetchFearGreed } from "./fear-greed.js";
import { fetchNews, NEWS_SOURCES } from "./news.js";
import type { EvidenceOptions } from "./http.js";

export function fetchEvidence(asset: Asset, options: EvidenceOptions = {}): Promise<Exhibit[]> {
  const fixed = { ...options, now: options.now ?? Date.now() };
  return Promise.all([
    fetchCandles(asset, "1h", "E1", fixed), fetchCandles(asset, "1d", "E2", fixed),
    fetchHyperliquid(asset, "E3", fixed), fetchFearGreed("E4", fixed),
    ...NEWS_SOURCES.map((source, i) => fetchNews(asset, source, `E${i + 5}`, fixed))
  ]);
}
