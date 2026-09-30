import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeSignals, newsTone, rsi14 } from "../src/signals.js";
import { AGENT_DIR } from "../src/paths.js";
import { fixture } from "./helpers.js";
import type { Asset, Candle } from "../src/types.js";

const expected = JSON.parse(readFileSync(resolve(AGENT_DIR, "test/fixtures/expected-signals.json"), "utf8")) as Record<Asset, Record<string, number>>;

describe("signals", () => {
  it.each(["BTC", "ETH", "SOL"] as const)("matches hand-checked %s returns and independent rational Wilder RSI", asset => {
    const signals = computeSignals(fixture(asset).exhibits);
    expect(signals).toHaveLength(14);
    for (const name of ["ret_1h", "ret_24h", "ret_7d", "rsi14_1h"])
      expect(signals.find(s => s.name === name)!.value).toBe(expected[asset][name]);
    for (const s of signals) if (s.value !== null) expect(s.value).toBe(Number(s.value.toFixed(6)));
  });
  it("uses Wilder's published seed example and handles monotone and flat series", () => {
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    const rows = closes.map((close, i): Candle => [i * 3600, close, close, close, close, 1]);
    expect(rsi14(rows)).toBeCloseTo(70.464135, 6);
    expect(rsi14(rows.map((row, i) => [row[0], 1 + i, 1 + i, 1 + i, 1 + i, 1]))).toBe(100);
    expect(rsi14(rows.map(row => [row[0], 2, 2, 2, 2, 1]))).toBe(50);
    expect(rsi14(rows.slice(1))).toBeNull();
  });
  it("makes every dependency on a failed source null", () => {
    const { exhibits } = fixture();
    exhibits[0] = { ...exhibits[0]!, status: "unavailable", error: "test", data: null };
    const signals = computeSignals(exhibits);
    for (const name of ["ret_1h", "ret_24h", "rsi14_1h", "atr14_1h_pct", "realized_vol_24h_pct", "price_vs_sma20d_pct"])
      expect(signals.find(s => s.name === name)!.value).toBeNull();
    expect(signals.find(s => s.name === "ret_7d")!.value).not.toBeNull();
  });
  it("requires all news feeds and detects candle gaps", () => {
    const { exhibits } = fixture();
    (exhibits[0]!.data as Candle[]).splice(25, 1);
    exhibits[5] = { ...exhibits[5]!, status: "unavailable", error: "test", data: null };
    const signals = computeSignals(exhibits);
    expect(signals.find(s => s.name === "rsi14_1h")!.value).toBeNull();
    expect(signals.find(s => s.name === "news_count_48h")!.value).toBeNull();
    expect(signals.find(s => s.name === "news_tone")!.value).toBeNull();
  });
  it("uses only whole words in the fixed tone lexicon", () => {
    const item = (title: string) => ({ title, link: "https://example.com", pubDate: "2026-01-01T00:00:00.000Z", source: "test" });
    expect(newsTone([item("Bitcoin rally gains approval; hack")])).toBe(0.5);
    expect(newsTone([item("Bitcoin crashes sideways")])).toBe(0);
    expect(newsTone([])).toBe(0);
  });
});
