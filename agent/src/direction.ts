import type { Config } from "./config.js";
import type { Signal } from "./types.js";

type Direction = "Long" | "Short" | "neutral" | "non-directional";

// Version 1 is selected only by the bundle's archived debate.directionCheck.
// Cutoffs come from the same config as judge version 1.
export function signalDirection(signal: Signal, config: Config): { direction: Direction; reason: string } {
  const { name, value, unit } = signal;
  if (value === null) return { direction: "neutral", reason: "signal has no value" };
  const t = config.judge.thresholds;
  const shown = `${name} is ${value}${unit === "index" || unit === "score" || !unit ? "" : ` ${unit}`}`;
  let direction: Direction;
  switch (name) {
    case "ret_1h": case "ret_24h": case "ret_7d": case "price_vs_sma20d_pct": case "news_tone":
      direction = value > 0 ? "Long" : value < 0 ? "Short" : "neutral";
      if (direction === "neutral") return { direction, reason: `${shown}, neutral at 0` };
      break;
    case "rsi14_1h": case "funding_annualized_pct": case "fng": {
      const [low, high] = name === "rsi14_1h" ? [t.rsiLow, t.rsiHigh]
        : name === "funding_annualized_pct" ? [t.fundingLowPct, t.fundingHighPct] : [t.fngLow, t.fngHigh];
      direction = value <= low ? "Long" : value >= high ? "Short" : "neutral";
      if (direction === "neutral") return { direction, reason: `${shown}, neutral between ${low} and ${high}` };
      break;
    }
    default: return { direction: "non-directional", reason: `${name} is non-directional` };
  }
  return { direction, reason: `${shown}, which favours ${direction}` };
}

export function directionStrike(signal: Signal, role: "bull" | "bear", config: Config): string | undefined {
  const expected = role === "bull" ? "Long" : "Short";
  const { direction, reason } = signalDirection(signal, config);
  if (direction === expected) return undefined;
  return direction === "Long" || direction === "Short" ? `${reason}, not ${expected}` : reason;
}
