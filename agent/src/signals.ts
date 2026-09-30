import type { Candle, Exhibit, FngItem, HyperData, NewsItem, Signal } from "./types.js";
import { round } from "./numbers.js";

export const POSITIVE_WORDS = ["gain", "gains", "rally", "surge", "surges", "rise", "rises", "bullish", "approval", "adoption", "growth", "record", "recovery"] as const;
export const NEGATIVE_WORDS = ["loss", "losses", "drop", "drops", "crash", "plunge", "falls", "bearish", "hack", "fraud", "ban", "outflow", "selloff"] as const;

const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const contiguous = (rows: Candle[], seconds: number) => rows.every((row, i) => i === 0 || row[0] - rows[i - 1]![0] === seconds);

export function rsi14(rows: Candle[]): number | null {
  if (rows.length < 15 || !contiguous(rows, 3600)) return null;
  const changes = rows.slice(1).map((row, i) => row[4] - rows[i]![4]);
  let gain = average(changes.slice(0, 14).map(n => Math.max(n, 0)));
  let loss = average(changes.slice(0, 14).map(n => Math.max(-n, 0)));
  for (const change of changes.slice(14)) {
    gain = (gain * 13 + Math.max(change, 0)) / 14;
    loss = (loss * 13 + Math.max(-change, 0)) / 14;
  }
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function atr14Pct(rows: Candle[]): number | null {
  if (rows.length < 14 || !contiguous(rows, 3600)) return null;
  const ranges = rows.map((row, i) => i === 0 ? row[2] - row[1]
    : Math.max(row[2] - row[1], Math.abs(row[2] - rows[i - 1]![4]), Math.abs(row[1] - rows[i - 1]![4])));
  let atr = average(ranges.slice(0, 14));
  for (const range of ranges.slice(14)) atr = (atr * 13 + range) / 14;
  return atr / rows.at(-1)![4] * 100;
}

export function newsTone(items: NewsItem[]): number {
  let positive = 0;
  let negative = 0;
  for (const item of items) {
    const words = item.title.toLowerCase().match(/[a-z]+/g) ?? [];
    for (const word of words) {
      if ((POSITIVE_WORDS as readonly string[]).includes(word)) positive++;
      if ((NEGATIVE_WORDS as readonly string[]).includes(word)) negative++;
    }
  }
  return positive + negative === 0 ? 0 : (positive - negative) / (positive + negative);
}

export function computeSignals(exhibits: Exhibit[]): Signal[] {
  const hourly = exhibits.filter(e => e.kind === "candles_1h");
  const daily = exhibits.filter(e => e.kind === "candles_1d");
  const hyper = exhibits.filter(e => e.kind === "hyperliquid");
  const fear = exhibits.filter(e => e.kind === "fear_greed");
  const news = exhibits.filter(e => e.kind === "news");
  const rows = (sources: Exhibit[]) => sources[0]?.status === "ok" ? sources[0].data as Candle[] : [];
  const h = rows(hourly);
  const d = rows(daily);
  const signals: Signal[] = [];
  const add = (name: string, value: number | null, unit: string, sources: Exhibit[], note: string) => {
    const missing = sources.length === 0 || sources.some(e => e.status !== "ok");
    signals.push({ name, value: missing || value === null || !Number.isFinite(value) ? null : round(value), unit,
      exhibits: sources.map(e => e.id), note: missing ? `Unavailable source: ${sources.filter(e => e.status !== "ok").map(e => e.id).join(", ") || "missing exhibit"}. ${note}` : note });
  };
  const ret = (candles: Candle[], seconds: number): number | null => {
    const last = candles.at(-1);
    const before = last && candles.find(row => row[0] === last[0] - seconds);
    return last && before ? (last[4] / before[4] - 1) * 100 : null;
  };
  add("ret_1h", ret(h, 3600), "%", hourly, "Close-to-close return over exactly one hour.");
  add("ret_24h", ret(h, 86400), "%", hourly, "Close-to-close return over exactly 24 hours.");
  add("ret_7d", ret(d, 7 * 86400), "%", daily, "Daily close-to-close return over exactly seven days.");
  add("price_vs_sma20d_pct", d.length >= 20 && contiguous(d.slice(-20), 86400) && h.length > 0
    ? (h.at(-1)![4] / average(d.slice(-20).map(row => row[4])) - 1) * 100 : null,
  "%", [...hourly, ...daily], "Latest hourly close relative to the mean of the latest 20 daily closes.");
  add("rsi14_1h", rsi14(h), "index", hourly, "Wilder RSI(14), seeded by the first 14 close changes; flat series is 50.");
  add("atr14_1h_pct", atr14Pct(h), "%", hourly, "Wilder ATR(14), seeded by the first 14 true ranges, divided by latest close.");
  const last25 = h.slice(-25);
  const logs = last25.slice(1).map((row, i) => Math.log(row[4] / last25[i]![4]));
  const mean = logs.length === 24 ? average(logs) : 0;
  const vol = logs.length === 24 && contiguous(last25, 3600)
    ? Math.sqrt(average(logs.map(n => (n - mean) ** 2))) * Math.sqrt(24) * 100 : null;
  add("realized_vol_24h_pct", vol, "%", hourly, "Population standard deviation of 24 hourly log returns, times sqrt(24) and 100.");
  const ctx = hyper[0]?.status === "ok" ? hyper[0].data as HyperData : null;
  add("funding_annualized_pct", ctx ? Number(ctx.funding) * 24 * 365 * 100 : null, "%/year", hyper, "Hourly Hyperliquid funding times 24 * 365 * 100; no compounding.");
  add("oi_usd", ctx ? Number(ctx.openInterest) * Number(ctx.markPx) : null, "USD", hyper, "Open interest in asset units times mark price.");
  add("premium_pct", ctx ? Number(ctx.premium) * 100 : null, "%", hyper, "Hyperliquid premium times 100.");
  const fng = fear[0]?.status === "ok" ? fear[0].data as FngItem[] : [];
  const current = fng.at(-1);
  const previous = current && fng.find(item => item.timestamp === current.timestamp - 7 * 86400);
  add("fng", current?.value ?? null, "index", fear, "Latest Fear & Greed value.");
  add("fng_change_7d", current && previous ? current.value - previous.value : null, "points", fear, "Latest index minus the observation exactly seven days earlier.");
  const newsItems = news.flatMap(e => e.status === "ok" ? e.data as NewsItem[] : []);
  add("news_count_48h", newsItems.length, "items", news, "Count of normalized matching titles; requires every news feed.");
  add("news_tone", newsTone(newsItems), "score", news, "Fixed title lexicon: (positive - negative) / matched words; no matches gives zero; requires every feed.");
  return signals;
}
