import { z } from "zod";
import type { Asset, Candle, Exhibit } from "../types.js";
import { round } from "../numbers.js";
import { fetchExhibit, type EvidenceOptions } from "./http.js";

const candleSchema = z.tuple([z.number().int().nonnegative(), z.number().nonnegative(), z.number().positive(),
  z.number().positive(), z.number().positive(), z.number().nonnegative()]);

export function normalizeCandles(raw: string, limit = Infinity): Candle[] {
  const rows = z.array(candleSchema).parse(JSON.parse(raw));
  const byTime = new Map<number, Candle>();
  // Sort before deduplication so duplicate timestamps have a stable winner.
  rows.sort((a, b) => a[0] - b[0] || (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
  for (const row of rows) {
    const [time, low, high, open, close, volume] = row;
    if (low > high || open < low || open > high || close < low || close > high)
      throw new Error("Invalid candle OHLC range");
    byTime.set(time, [time, round(low, 8), round(high, 8), round(open, 8), round(close, 8), round(volume, 8)]);
  }
  const candles = [...byTime.values()];
  if (candles.length === 0) throw new Error("Empty candle response");
  return candles.slice(-limit);
}

export function fetchCandles(asset: Asset, period: "1h" | "1d", id: string, options: EvidenceOptions = {}): Promise<Exhibit> {
  const granularity = period === "1h" ? 3600 : 86400;
  return fetchExhibit({ id, kind: period === "1h" ? "candles_1h" : "candles_1d", source: "Coinbase",
    url: `https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=${granularity}`, method: "GET" },
  raw => normalizeCandles(raw, period === "1h" ? 72 : 60), options);
}

export async function fetchReviewCandles(asset: Asset, openedAt: number, now: number, options: EvidenceOptions = {}): Promise<Exhibit[]> {
  const exhibits: Exhibit[] = [];
  const firstHour = Math.floor(openedAt / 3600) * 3600;
  for (let start = firstHour; start <= now; start += 299 * 3600) {
    const end = Math.min(start + 299 * 3600, now);
    const url = new URL(`https://api.exchange.coinbase.com/products/${asset}-USD/candles`);
    url.searchParams.set("granularity", "3600");
    url.searchParams.set("start", new Date(start * 1000).toISOString());
    url.searchParams.set("end", new Date(end * 1000).toISOString());
    exhibits.push(await fetchExhibit({ id: `E${exhibits.length + 1}`, kind: "candles_1h", source: "Coinbase",
      url: url.toString(), method: "GET" }, raw => normalizeCandles(raw), options));
  }
  return exhibits;
}
