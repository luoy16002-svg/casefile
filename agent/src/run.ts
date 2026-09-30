import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { z } from "zod";
import { loadConfig, saveConfig } from "./config.js";
import { fetchEvidence } from "./evidence/index.js";
import { computeSignals } from "./signals.js";
import { buildDebate } from "./debate.js";
import { judge, JUDGE_VERSION } from "./judge.js";
import { saveBundle } from "./bundle.js";
import { agentAddress, connectLedger } from "./ledger.js";
import { ROOT, exists, readJson, workspacePath, writeJson } from "./paths.js";
import { bundleSchema } from "./schemas.js";
import type { Asset, Bundle } from "./types.js";
import { cli, isMain } from "./cli.js";
import { errorMessage } from "./evidence/http.js";

const indexSchema = z.array(z.object({ id: z.string().regex(/^[1-9][0-9]*$/), bundleHash: z.string(), asset: z.string(), side: z.string(), tx: z.string(), openedAt: z.number().int() }).strict());

export async function run(): Promise<void> {
  const { values } = parseArgs({ options: { assets: { type: "string" }, "dry-run": { type: "boolean" }, "no-llm": { type: "boolean" }, out: { type: "string" } } });
  const { config, configHash } = await loadConfig();
  const dry = values["dry-run"] ?? false;
  if (!dry && values.out) throw new Error("--out is only supported for --dry-run");
  const assets = values.assets ? [...new Set(values.assets.split(",").map(s => s.trim()))] : config.assets;
  if (!assets.length || assets.some(a => !config.assets.includes(a as Asset))) throw new Error("--assets must contain configured assets BTC, ETH, SOL");
  const out = await workspacePath(dry ? resolve(values.out ?? "./tmp") : resolve(ROOT, "cases"));
  const agent = agentAddress(dry);
  const ledger = dry ? undefined : await connectLedger(config, true);
  let failures = 0;
  for (const asset of assets as Asset[]) {
    try {
      const createdAt = new Date().toISOString();
      await saveConfig(config);
      const exhibits = await fetchEvidence(asset, { now: Date.parse(createdAt) });
      for (const e of exhibits) console.log(`${asset} ${e.id} ${e.source} ${e.kind}: ${e.status}${e.error ? ` (${e.error})` : ""}`);
      const signals = computeSignals(exhibits);
      const debate = await buildDebate(exhibits, signals, config, { noLlm: values["no-llm"] });
      const ruling = judge(signals, debate, exhibits, config);
      const bundle: Bundle = bundleSchema.parse({ schema: "casefile/1", agent, asset, createdAt, judgeVersion: JUDGE_VERSION,
        configHash, codeRef: process.env.GITHUB_SHA ?? "local", exhibits, signals, debate, ruling });
      const bundleHash = await saveBundle(bundle, out);
      console.log(`${asset}: ${ruling.side}, score=${ruling.score}, bundle=${bundleHash}, path=${resolve(out, `${bundleHash}.json`)}`);
      if (ledger) {
        if (ruling.entryE8 === "0") throw new Error(`${asset}: hourly entry unavailable; saved bundle cannot be sealed until valid evidence is available`);
        const opened = await ledger.open(bundleHash, asset, ruling);
        const indexPath = resolve(ROOT, "cases", "index.json");
        const index = await exists(indexPath) ? indexSchema.parse(await readJson(indexPath)) : [];
        index.push({ ...opened, bundleHash, asset, side: ruling.side });
        await writeJson(indexPath, index);
        console.log(`Opened case ${opened.id}, tx=${opened.tx}, openedAt=${opened.openedAt}`);
      }
    } catch (error) { failures++; console.error(`${asset}: ${errorMessage(error)}`); }
  }
  if (failures) throw new Error(`${failures} asset(s) failed`);
}
if (isMain(import.meta.url)) await cli(run);
