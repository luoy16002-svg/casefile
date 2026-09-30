import { z } from "zod";
import { resolve } from "node:path";
import { AGENT_DIR, exists, readJson, writeImmutable } from "./paths.js";
import { canonicalJson, hashBundle } from "./bundle.js";

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
  debate: z.object({ directionCheck: z.literal("v1") }).strict().optional(),
  llm: z.object({ provider: z.enum(["ollama", "github-models", "none"]), model: z.string().min(1), temperature: z.number().min(0).max(2) }).strict(),
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

export const CONFIGS_DIR = resolve(AGENT_DIR, "configs");

export async function saveConfig(config: Config, directory = CONFIGS_DIR): Promise<void> {
  const validated = configSchema.parse(config);
  await writeImmutable(resolve(directory, `${hashBundle(validated)}.json`), canonicalJson(validated));
}

export async function loadConfigForHash(configHash: string, current?: Config, directory = CONFIGS_DIR): Promise<Config> {
  if (!/^0x[0-9a-f]{64}$/.test(configHash)) throw new Error(`Invalid config hash: ${configHash}`);
  const path = resolve(directory, `${configHash}.json`);
  if (await exists(path)) {
    const config = configSchema.parse(await readJson(path));
    if (hashBundle(config) !== configHash) throw new Error(`Archived config hash mismatch: ${path}`);
    return config;
  }
  const config = current ?? (await loadConfig()).config;
  if (hashBundle(config) === configHash) return config;
  throw new Error(`No config found for ${configHash}; restore agent/configs/${configHash}.json`);
}
