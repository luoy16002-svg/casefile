import { z } from "zod";
import { resolve } from "node:path";
import { AGENT_DIR, readJson } from "./paths.js";
import { hashBundle } from "./bundle.js";

const weight = z.number().finite().nonnegative();
export const configSchema = z.object({
  assets: z.array(z.enum(["BTC", "ETH", "SOL"])).min(1),
  horizonHours: z.number().min(1).max(720).refine(n => Number.isInteger(n * 3600)),
  risk: z.object({
    maxSizeBps: z.number().int().min(1).max(10000), minStopPct: z.number().positive(),
    maxStopPct: z.number().positive().max(99), rewardRisk: z.number().positive()
  }).strict(),
  judge: z.object({
    weights: z.object({ trend: weight, momentum: weight, rsi_extreme: weight,
      funding_crowding: weight, sentiment_extreme: weight, news_tone: weight, debate: weight }).strict(),
    thresholds: z.object({ longScore: z.number().positive().max(1), shortScore: z.number().negative().min(-1),
      trendPct: z.number().positive(), rsiHigh: z.number().min(0).max(100), rsiLow: z.number().min(0).max(100),
      fundingHighPct: z.number(), fundingLowPct: z.number(), fngHigh: z.number().min(0).max(100), fngLow: z.number().min(0).max(100)
    }).strict()
  }).strict(),
  llm: z.object({ provider: z.enum(["github-models", "none"]), model: z.string().min(1), temperature: z.number().min(0).max(2) }).strict(),
  chain: z.object({ chainId: z.number().int().positive(), rpc: z.url() }).strict()
}).strict().superRefine((config, ctx) => {
  if (config.risk.minStopPct > config.risk.maxStopPct || config.risk.maxStopPct * config.risk.rewardRisk >= 100)
    ctx.addIssue({ code: "custom", message: "Invalid stop/target risk bounds" });
  const t = config.judge.thresholds;
  if (t.rsiLow >= t.rsiHigh || t.fngLow >= t.fngHigh || t.fundingLowPct >= t.fundingHighPct)
    ctx.addIssue({ code: "custom", message: "Judge thresholds must be ordered" });
});
export type Config = z.infer<typeof configSchema>;

export async function loadConfig(): Promise<{ config: Config; configHash: `0x${string}` }> {
  const raw = await readJson(resolve(AGENT_DIR, "casefile.config.json"));
  const config = configSchema.parse(raw);
  return { config, configHash: hashBundle(config) };
}
