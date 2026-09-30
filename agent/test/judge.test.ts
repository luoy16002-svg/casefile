import { describe, expect, it } from "vitest";
import { judge } from "../src/judge.js";
import { canonicalJson } from "../src/bundle.js";
import { config, emptyBrief, fixture, testSignals } from "./helpers.js";

const debate = { bull: emptyBrief(), bear: emptyBrief() };
function trendOnly() {
  const c = structuredClone(config);
  for (const rule of Object.keys(c.judge.weights) as (keyof typeof c.judge.weights)[]) c.judge.weights[rule] = rule === "trend" ? 1 : 0;
  return c;
}
const entry = () => [{ ...fixture().exhibits[0]!, data: [[0, 99, 101, 100, 100, 1] as [number, number, number, number, number, number]] }];

describe("judge version 1", () => {
  it.each([[0.75, "Long"], [-0.75, "Short"], [0.749997, "Flat"], [-0.749997, "Flat"]] as const)("applies score boundary %s", (trend, side) => {
    expect(judge(testSignals({ price_vs_sma20d_pct: trend }), debate, entry(), trendOnly()).side).toBe(side);
  });
  it("produces byte-identical rulings without changing input", () => {
    const signals = testSignals({ ret_24h: 2, rsi14_1h: 78, fng: 20 });
    const before = canonicalJson(signals);
    expect(canonicalJson(judge(signals, debate, entry(), config))).toBe(canonicalJson(judge(signals, debate, entry(), config)));
    expect(canonicalJson(signals)).toBe(before);
  });
  it.each([[3, "Long", "9400000000", "11200000000"], [-3, "Short", "10600000000", "8800000000"]] as const)("computes %s trend risk with integer E8 arithmetic", (trend, side, stop, target) => {
    const r = judge(testSignals({ price_vs_sma20d_pct: trend }), debate, entry(), trendOnly());
    expect(r.side).toBe(side); expect(r.entryE8).toBe("10000000000");
    expect(r.stopE8).toBe(stop); expect(r.targetE8).toBe(target);
    expect(r.sizeBps).toBe(1000); expect(r.horizonSec).toBe(86400);
  });
  it("forces Flat without ATR even when the score is Long", () => {
    const r = judge(testSignals({ price_vs_sma20d_pct: 3, atr14_1h_pct: null }), debate, entry(), trendOnly());
    expect(r.score).toBe(1); expect(r.side).toBe("Flat"); expect(r.sizeBps).toBe(0);
    expect(r.stopE8).toBe("0"); expect(r.targetE8).toBe("0"); expect(r.summary).toContain("Missing ATR");
  });
  it("excludes missing inputs from the denominator and records neutral reasons", () => {
    const c = trendOnly(); c.judge.weights.momentum = 1;
    const r = judge(testSignals({ price_vs_sma20d_pct: 3, ret_24h: null }), debate, entry(), c);
    expect(r.score).toBe(1);
    expect(r.contributions.find(rule => rule.rule === "momentum")).toMatchObject({ vote: 0, weight: 1 });
    expect(r.contributions.find(rule => rule.rule === "momentum")!.reason).toContain("Missing ret_24h");
  });
  it("treats zero volatility neutrally and bounds the debate vote", () => {
    const d = { bull: { ...emptyBrief(), strength: 1, claims: [{ text: "x", cites: ["E1"], signal: null }] }, bear: emptyBrief() };
    const r = judge(testSignals({ realized_vol_24h_pct: 0, ret_24h: 4 }), d, entry(), config);
    expect(r.contributions.find(c => c.rule === "momentum")!.vote).toBe(0);
    expect(r.contributions.find(c => c.rule === "debate")!.vote).toBe(0.5);
  });
  it("implements exact RSI, funding and sentiment cutoffs", () => {
    const votes = (overrides: Record<string, number>) => Object.fromEntries(judge(testSignals(overrides), debate, entry(), config).contributions.map(c => [c.rule, c.vote]));
    expect(votes({ rsi14_1h: 75, funding_annualized_pct: 30, fng: 80 })).toMatchObject({ rsi_extreme: -1, funding_crowding: -0.5, sentiment_extreme: -0.5 });
    expect(votes({ rsi14_1h: 25, funding_annualized_pct: -10, fng: 20 })).toMatchObject({ rsi_extreme: 1, funding_crowding: 0.5, sentiment_extreme: 0.5 });
    expect(votes({ rsi14_1h: 50, funding_annualized_pct: 0, fng: 50 })).toMatchObject({ rsi_extreme: 0, funding_crowding: 0, sentiment_extreme: 0 });
  });
});
