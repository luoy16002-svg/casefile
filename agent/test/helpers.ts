import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { configSchema } from "../src/config.js";
import { AGENT_DIR } from "../src/paths.js";
import { exhibitSchema } from "../src/schemas.js";
import { hashBundle } from "../src/bundle.js";
import { computeSignals } from "../src/signals.js";
import { buildDebate } from "../src/debate.js";
import { judge, JUDGE_VERSION } from "../src/judge.js";
import type { Asset, Brief, Bundle, Exhibit, LedgerCase, Signal } from "../src/types.js";

export const config = configSchema.parse(JSON.parse(readFileSync(resolve(AGENT_DIR, "casefile.config.json"), "utf8")));
export const testAgent = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
export function fixture(asset: Asset = "BTC"): { exhibits: Exhibit[]; recordedAt: string } {
  const raw = JSON.parse(readFileSync(resolve(AGENT_DIR, "test", "fixtures", `${asset}.json`), "utf8")) as { exhibits: unknown[]; recordedAt: string };
  return { exhibits: raw.exhibits.map(e => exhibitSchema.parse(e)), recordedAt: raw.recordedAt };
}
export async function fixtureBundle(asset: Asset = "BTC"): Promise<Bundle> {
  const { exhibits, recordedAt } = fixture(asset);
  const signals = computeSignals(exhibits);
  const debate = await buildDebate(exhibits, signals, config, { noLlm: true });
  return { schema: "casefile/1", agent: testAgent, asset, createdAt: recordedAt, judgeVersion: JUDGE_VERSION,
    configHash: hashBundle(config), codeRef: "local", exhibits, signals, debate, ruling: judge(signals, debate, exhibits, config) };
}
export const emptyBrief = (): Brief => ({ mode: "template", model: "test", prompt: "test", rawResponse: "{}", claims: [], struck: [], strength: 0 });
export function testSignals(overrides: Record<string, number | null> = {}): Signal[] {
  const values: Record<string, number | null> = { price_vs_sma20d_pct: 0, ret_24h: 0, realized_vol_24h_pct: 1,
    rsi14_1h: 50, funding_annualized_pct: 0, fng: 50, news_tone: 0, atr14_1h_pct: 1, ...overrides };
  return Object.entries(values).map(([name, value]) => ({ name, value, unit: "%", exhibits: ["E1"], note: "test" }));
}
export function ledgerCase(overrides: Partial<LedgerCase> = {}): LedgerCase {
  return { agent: testAgent, bundleHash: `0x${"1".repeat(64)}`, asset: `0x${"0".repeat(64)}`, side: 1, sizeBps: 2000,
    entryE8: 10000000000n, stopE8: 9500000000n, targetE8: 11000000000n, openedAt: 3600n, horizon: 7200,
    closedAt: 0n, exitE8: 0n, pnlBps: 0, reason: 0, reviewHash: `0x${"0".repeat(64)}`, ...overrides };
}
