import { describe, expect, it, vi } from "vitest";
import { canonicalJson, hashBundle } from "../src/bundle.js";
import { buildDebate, templateBrief, validateClaims } from "../src/debate.js";
import { judge, JUDGE_VERSION } from "../src/judge.js";
import { replayTrail, verifyBundle, verifyBundleWithConfig } from "../src/replay.js";
import type { Claim, Signal } from "../src/types.js";
import { config, fixture, fixtureBundle, testSignals } from "./helpers.js";

const exhibits = fixture().exhibits;
const signed = ["ret_1h", "ret_24h", "ret_7d", "price_vs_sma20d_pct", "news_tone"];
const nonDirectional = ["atr14_1h_pct", "realized_vol_24h_pct", "oi_usd", "premium_pct", "fng_change_7d", "news_count_48h"];
const names = [...signed, "rsi14_1h", "funding_annualized_pct", "fng", ...nonDirectional];
const signal = (name: string, value: number | null): Signal => ({ name, value,
  unit: name === "funding_annualized_pct" ? "%/year" : name === "fng" || name === "rsi14_1h" ? "index" : "%",
  exhibits: ["E1"], note: "mock" });
const claim = (name: string | null, text = "Evidence supports the case"): Claim => ({ text, cites: ["E1"], signal: name });
function validate(name: string, value: number | null, role: "bull" | "bear") {
  return validateClaims([claim(name)], exhibits, [signal(name, value)], { role, config });
}
function expectSide(name: string, value: number, side: "Long" | "Short" | "neutral") {
  for (const role of ["bull", "bear"] as const) {
    const result = validate(name, value, role);
    const survives = side === (role === "bull" ? "Long" : "Short");
    expect(result.claims).toHaveLength(survives ? 1 : 0);
    expect(result.struck).toHaveLength(survives ? 0 : 1);
    expect(result.unchecked).toBe(0);
    if (!survives) expect(result.struck[0]!.reason).toContain(side === "neutral" ? "neutral" : `favours ${side}, not`);
  }
}

describe("direction check v1", () => {
  it.each(signed)("checks both signs and exact zero for %s", name => {
    expectSide(name, -0.000001, "Short");
    expectSide(name, 0, "neutral");
    expectSide(name, 0.000001, "Long");
  });
  it.each([
    ["rsi14_1h", 25, 75], ["funding_annualized_pct", -10, 30], ["fng", 20, 80]
  ] as const)("checks inclusive boundaries and adjacent values for %s", (name, low, high) => {
    expectSide(name, low - 0.000001, "Long");
    expectSide(name, low, "Long");
    expectSide(name, low + 0.000001, "neutral");
    expectSide(name, high - 0.000001, "neutral");
    expectSide(name, high, "Short");
    expectSide(name, high + 0.000001, "Short");
    expectSide(name, 0, name === "funding_annualized_pct" ? "neutral" : "Long");
  });
  it.each(nonDirectional)("strikes %s for either role regardless of its sign", name => {
    for (const value of [-1, 0, 1]) for (const role of ["bull", "bear"] as const) {
      expect(validate(name, value, role).struck).toEqual([{ claim: claim(name), reason: `${name} is non-directional` }]);
    }
  });
  it.each(names)("strikes a null value for %s for both roles", name => {
    for (const role of ["bull", "bear"] as const)
      expect(validate(name, null, role).struck).toEqual([{ claim: claim(name), reason: "signal has no value" }]);
  });
  it("records the concrete threshold mistakes from the brief", () => {
    expect(validate("price_vs_sma20d_pct", 2.117795, "bear").struck[0]!.reason)
      .toBe("price_vs_sma20d_pct is 2.117795 %, which favours Long, not Short");
    expect(validate("funding_annualized_pct", -3.75, "bull").struck[0]!.reason)
      .toBe("funding_annualized_pct is -3.75 %/year, neutral between -10 and 30");
    for (const role of ["bull", "bear"] as const)
      expect(validate("fng", 71, role).struck[0]!.reason).toBe("fng is 71, neutral between 20 and 80");
  });
  it("uses the judge's configurable cutoffs in validation, reasons and templates", () => {
    const changed = structuredClone(config);
    Object.assign(changed.judge.thresholds, { rsiLow: 40, rsiHigh: 60, fundingLowPct: -2, fundingHighPct: 5, fngLow: 35, fngHigh: 65 });
    const signals = testSignals({ rsi14_1h: 40, funding_annualized_pct: -2, fng: 35 });
    const claims = ["rsi14_1h", "funding_annualized_pct", "fng"].map(name => claim(name));
    expect(validateClaims(claims, exhibits, signals, { role: "bull", config: changed }).claims).toEqual(claims);
    const bull = templateBrief("bull", signals, exhibits, "test", undefined, changed);
    expect(bull.claims.map(c => c.signal)).toEqual(claims.map(c => c.signal));
    expect(bull.struck).toEqual([]); expect(bull.unchecked).toBe(0);
    const neutral = validateClaims([claim("fng")], exhibits, testSignals({ fng: 50 }), { role: "bull", config: changed });
    expect(neutral.struck[0]!.reason).toBe("fng is 50 %, neutral between 35 and 65");
    const bear = templateBrief("bear", testSignals({ rsi14_1h: 60, funding_annualized_pct: 5, fng: 65 }), exhibits, "test", undefined, changed);
    expect(bear.claims.map(c => c.signal)).toEqual(claims.map(c => c.signal));
    const ruling = judge(signals, { bull, bear }, exhibits, changed);
    expect(ruling.contributions.find(c => c.rule === "debate")!.reason).toContain("Bull has 3 surviving claims");
    expect(JUDGE_VERSION).toBe("1");
  });
  it("keeps and counts surviving null-signal claims after citation checks", () => {
    const unchecked = claim(null, "rsi14_1h is discussed without a declared signal");
    const missing = { ...claim(null), cites: [] };
    const result = validateClaims([unchecked, missing, claim("ret_24h")], exhibits, [signal("ret_24h", 1)], { role: "bull", config });
    expect(result.claims).toEqual([unchecked, claim("ret_24h")]);
    expect(result.unchecked).toBe(1);
    expect(result.struck).toEqual([{ claim: missing, reason: "No exhibit citations" }]);
  });
  it("preserves citation/unknown-signal reasons before direction checking", () => {
    const claims = [{ ...claim("ret_24h"), cites: ["E99"] }, claim("imaginary")];
    const result = validateClaims(claims, exhibits, [signal("ret_24h", -1)], { role: "bull", config });
    expect(result.struck.map(c => c.reason)).toEqual(["Unknown exhibit E99", "Unknown signal imaginary"]);
  });
  it("strikes a single mismatched identifier but skips ambiguous prose and multiple signals", () => {
    const signals = [signal("ret_24h", 1), signal("rsi14_1h", 25)];
    const mismatch = claim("ret_24h", "rsi14_1h is 25");
    const kept = [claim("ret_24h", "ret_24h is positive"), claim("ret_24h", "RSI is oversold"),
      claim("ret_24h", "ret_24h and rsi14_1h support Long"), claim("ret_24h", "prefix_rsi14_1h is text")];
    const result = validateClaims([mismatch, ...kept], exhibits, signals, { role: "bull", config });
    expect(result.claims).toEqual(kept);
    expect(result.struck).toEqual([{ claim: mismatch, reason: "Claim text names rsi14_1h, but signal is ret_24h" }]);
  });
  it("preserves legacy validation and omits unchecked when the config flag is absent", () => {
    const legacy = structuredClone(config); delete legacy.debate;
    const claims = [claim("fng", "ret_24h is positive"), claim(null)];
    const result = validateClaims(claims, exhibits, [signal("fng", 71), signal("ret_24h", 1)], { role: "bull", config: legacy });
    expect(result).toEqual({ claims, struck: [] });
  });
  it("replays a mocked new-format bundle and rejects rewritten reasons, counts and surviving directions", async () => {
    const bundle = await fixtureBundle();
    const rawResponse = JSON.stringify({ claims: [claim("atr14_1h_pct"), claim(null), claim("ret_24h")], strength: 0.8 });
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async url => new Response(JSON.stringify(
      String(url).endsWith("/api/tags") ? { models: [] } : { message: { content: rawResponse } }
    )));
    bundle.debate = await buildDebate(bundle.exhibits, bundle.signals, config, { fetchFn });
    bundle.ruling = judge(bundle.signals, bundle.debate, bundle.exhibits, config);
    const changedCurrent = structuredClone(config); delete changedCurrent.debate;
    changedCurrent.judge.thresholds.rsiLow = 10;
    const verified = await verifyBundleWithConfig(canonicalJson(bundle), hashBundle(bundle), changedCurrent);
    expect(verified.config).toEqual(config);
    expect(verified.bundle).toEqual(bundle);
    expect(bundle.debate.bull).toMatchObject({ mode: "llm", rawResponse, unchecked: 1 });
    expect(bundle.debate.bear.unchecked).toBe(1);
    expect(bundle.debate.bull.struck[0]!.reason).toBe("atr14_1h_pct is non-directional");
    expect(replayTrail(bundle, hashBundle(bundle))).toContain("Unchecked claims: 1");
    const rewritten = structuredClone(bundle); rewritten.debate.bull.struck[0]!.reason = "Rewritten reason";
    expect(() => verifyBundle(canonicalJson(rewritten), config)).toThrow("struck-claim validation mismatch");
    const wrongCount = structuredClone(bundle); wrongCount.debate.bull.unchecked = 0;
    expect(() => verifyBundle(canonicalJson(wrongCount), config)).toThrow("unchecked count mismatch");
    const absentCount = structuredClone(bundle); delete absentCount.debate.bull.unchecked;
    expect(() => verifyBundle(canonicalJson(absentCount), config)).toThrow("unchecked count mismatch");
    const wrongDirection = structuredClone(bundle); wrongDirection.debate.bull.claims = [claim("atr14_1h_pct")];
    expect(() => verifyBundle(canonicalJson(wrongDirection), config)).toThrow("invalid surviving claims");
    expect(bundle.ruling.contributions.find(c => c.rule === "debate")!.reason)
      .toContain(`Bull has ${bundle.debate.bull.claims.length} surviving claims`);
  });
});
