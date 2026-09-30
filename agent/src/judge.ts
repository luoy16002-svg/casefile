import type { Config } from "./config.js";
import type { Candle, Contribution, Debate, Exhibit, Ruling, Signal } from "./types.js";
import { clamp, priceE8, round } from "./numbers.js";

export const JUDGE_VERSION = "1";

export function judge(signals: Signal[], debate: Debate, exhibits: Exhibit[], config: Config): Ruling {
  const values = new Map(signals.map(s => [s.name, s.value]));
  const t = config.judge.thresholds;
  const contributions: Contribution[] = [];
  let weighted = 0;
  let denominator = 0;
  const add = (rule: keyof Config["judge"]["weights"], inputs: string[], calculate: (numbers: number[]) => [number, string]) => {
    const missing = inputs.filter(name => values.get(name) === null || values.get(name) === undefined);
    const [vote, reason] = missing.length > 0 ? [0, `Missing ${missing.join(", ")}; neutral vote, excluded from score denominator.`] as const
      : calculate(inputs.map(name => values.get(name)!));
    const weight = config.judge.weights[rule];
    const recordedVote = round(vote);
    contributions.push({ rule, vote: recordedVote, weight, inputs, reason });
    if (missing.length === 0) { weighted += recordedVote * weight; denominator += weight; }
  };
  add("trend", ["price_vs_sma20d_pct"], ([n]) => [clamp(n! / t.trendPct, -1, 1), `Price versus SMA20d is ${n}%; linear vote saturates at ±${t.trendPct}%.`]);
  add("momentum", ["ret_24h", "realized_vol_24h_pct"], ([ret, vol]) => [vol! > 0 ? clamp(ret! / vol!, -1, 1) : 0,
    vol! > 0 ? `24-hour return ${ret}% divided by volatility ${vol}%.` : "Zero realized volatility; neutral vote."]);
  add("rsi_extreme", ["rsi14_1h"], ([n]) => [n! >= t.rsiHigh ? -1 : n! <= t.rsiLow ? 1 : 0, `RSI is ${n}; oversold ≤${t.rsiLow}, overbought ≥${t.rsiHigh}.`]);
  add("funding_crowding", ["funding_annualized_pct"], ([n]) => [n! >= t.fundingHighPct ? -0.5 : n! <= t.fundingLowPct ? 0.5 : 0,
    `Annualized funding is ${n}%; crowding thresholds are ${t.fundingLowPct}% and ${t.fundingHighPct}%.`]);
  add("sentiment_extreme", ["fng"], ([n]) => [n! >= t.fngHigh ? -0.5 : n! <= t.fngLow ? 0.5 : 0, `Fear & Greed is ${n}; contrarian thresholds are ${t.fngLow} and ${t.fngHigh}.`]);
  add("news_tone", ["news_tone"], ([n]) => [clamp(n!, -1, 1), `Fixed news-title lexicon tone is ${n}.`]);
  const bull = debate.bull.claims.length;
  const bear = debate.bear.claims.length;
  add("debate", [], () => [clamp((bull * debate.bull.strength - bear * debate.bear.strength) / Math.max(bull + bear, 1), -0.5, 0.5),
    `Bull has ${bull} surviving claims at strength ${debate.bull.strength}; bear has ${bear} at ${debate.bear.strength}; vote bounded to ±0.5.`]);
  const score = round(denominator > 0 ? weighted / denominator : 0);
  let side: Ruling["side"] = score >= t.longScore ? "Long" : score <= t.shortScore ? "Short" : "Flat";
  const hourly = exhibits.find(e => e.kind === "candles_1h" && e.status === "ok");
  const latest = (hourly?.data as Candle[] | undefined)?.at(-1);
  const entry = latest ? priceE8(latest[4]) : 0n;
  const atr = values.get("atr14_1h_pct");
  const unavailableRisk = atr === null || atr === undefined || entry === 0n;
  if (unavailableRisk) side = "Flat";
  const stopPct = atr === null || atr === undefined ? 0
    : round(clamp(1.5 * atr * Math.sqrt(config.horizonHours), config.risk.minStopPct, config.risk.maxStopPct), 4);
  let stop = 0n;
  let target = 0n;
  let sizeBps = 0;
  if (side !== "Flat") {
    const stopDistance = BigInt(Math.round(stopPct * 10000));
    const targetDistance = BigInt(Math.round(stopPct * config.risk.rewardRisk * 10000));
    // Integer E8 levels rounded to nearest, with half ties upward.
    const at = (pct: bigint) => (entry * pct + 500000n) / 1000000n;
    stop = at(1000000n + (side === "Long" ? -stopDistance : stopDistance));
    target = at(1000000n + (side === "Long" ? targetDistance : -targetDistance));
    sizeBps = Math.max(1, Math.round(config.risk.maxSizeBps * Math.min(1, Math.abs(score)) * Math.min(1, 3 / stopPct)));
    if (stop === entry || target === entry || target <= 0n || stop > 18446744073709551615n || target > 18446744073709551615n)
      throw new Error("Risk levels cannot be represented as valid uint64 E8 prices");
  }
  const reasons = contributions.map(c => `${c.rule} voted ${c.vote} at weight ${c.weight}: ${c.reason}`).join(" ");
  const summary = `Score ${score} yields ${side} (Long ≥${t.longScore}, Short ≤${t.shortScore}). ${reasons} `
    + (unavailableRisk ? "Missing ATR or hourly entry forces Flat; an absent entry cannot be sealed on-chain."
      : side === "Flat" ? "No paper position is opened; the Flat case is still sealed."
        : `Paper size is ${sizeBps} bps, stop distance ${stopPct}%, target distance ${round(stopPct * config.risk.rewardRisk, 4)}%, horizon ${config.horizonHours} hours.`);
  return { side, sizeBps, entryE8: entry.toString(), stopE8: stop.toString(), targetE8: target.toString(),
    horizonSec: config.horizonHours * 3600, score, contributions, summary };
}
