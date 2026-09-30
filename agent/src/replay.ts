import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { canonicalJson, hashBundle } from "./bundle.js";
import { loadConfig, type Config } from "./config.js";
import { validateClaims } from "./debate.js";
import { judge, JUDGE_VERSION } from "./judge.js";
import { computeSignals } from "./signals.js";
import { assetBytes, connectLedger, sideNumber } from "./ledger.js";
import { ROOT, exists, workspacePath } from "./paths.js";
import { bundleSchema } from "./schemas.js";
import { USER_AGENT } from "./evidence/http.js";
import { round } from "./numbers.js";
import type { Bundle, LedgerCase } from "./types.js";
import { cli, isMain } from "./cli.js";

const equal = (a: unknown, b: unknown, label: string) => {
  if (canonicalJson(a) !== canonicalJson(b)) throw new Error(`${label} mismatch`);
};

export function verifyBundle(bytes: string, config: Config, expectedHash?: string): { bundle: Bundle; hash: `0x${string}` } {
  const raw: unknown = JSON.parse(bytes);
  const canonical = canonicalJson(raw);
  if (bytes !== canonical) throw new Error("Bundle bytes are not canonical JSON");
  const hash = hashBundle(raw);
  if (expectedHash && hash !== expectedHash.toLowerCase()) throw new Error("Bundle hash mismatch");
  const bundle = bundleSchema.parse(raw);
  if (bundle.judgeVersion !== JUDGE_VERSION) throw new Error(`Unsupported judge version ${bundle.judgeVersion}`);
  if (bundle.configHash !== hashBundle(config)) throw new Error("Config hash mismatch; use the original casefile.config.json");
  const signals = computeSignals(bundle.exhibits);
  equal(signals, bundle.signals, "Signals");
  for (const role of ["bull", "bear"] as const) {
    const brief = bundle.debate[role];
    const accepted = validateClaims(brief.claims, bundle.exhibits, signals);
    if (accepted.struck.length) throw new Error(`${role} contains invalid surviving claims`);
    for (const struck of brief.struck) {
      const result = validateClaims([struck.claim], bundle.exhibits, signals);
      if (result.struck.length !== 1 || result.struck[0]!.reason !== struck.reason) throw new Error(`${role} struck-claim validation mismatch`);
    }
  }
  equal(judge(signals, bundle.debate, bundle.exhibits, config), bundle.ruling, "Ruling");
  return { bundle, hash };
}

export function verifyChain(bundle: Bundle, hash: string, c: LedgerCase): void {
  const r = bundle.ruling;
  if (c.bundleHash.toLowerCase() !== hash.toLowerCase()) throw new Error("On-chain bundle hash mismatch");
  if (c.agent.toLowerCase() !== bundle.agent.toLowerCase() || c.asset !== assetBytes(bundle.asset)
    || c.side !== sideNumber[r.side] || c.sizeBps !== r.sizeBps || c.entryE8 !== BigInt(r.entryE8)
    || c.stopE8 !== BigInt(r.stopE8) || c.targetE8 !== BigInt(r.targetE8) || c.horizon !== r.horizonSec)
    throw new Error("On-chain opening fields mismatch");
}

export function replayTrail(bundle: Bundle, hash: string): string {
  const lines = [`Casefile ${hash}`, `${bundle.asset} agent=${bundle.agent} judge=${bundle.judgeVersion}`, "Exhibits:"];
  for (const e of bundle.exhibits) lines.push(`  ${e.id} ${e.kind} ${e.source} ${e.status} sha256=${e.responseSha256}${e.error ? ` error=${e.error}` : ""}`);
  lines.push("Signals:");
  for (const s of bundle.signals) lines.push(`  ${s.name}=${s.value ?? "null"} ${s.unit} [${s.exhibits.join(",")}] ${s.note}`);
  lines.push("Rule contributions:");
  for (const c of bundle.ruling.contributions) lines.push(`  ${c.rule}: ${c.vote} × ${c.weight} = ${round(c.vote * c.weight)}; ${c.reason}`);
  for (const role of ["bull", "bear"] as const) {
    const brief = bundle.debate[role];
    lines.push(`${role} (${brief.mode}, model=${brief.model}, strength=${brief.strength})${brief.error ? ` fallback=${brief.error}` : ""}:`);
    for (const c of brief.claims) lines.push(`  SURVIVES [${c.cites.join(",")}] ${c.text}`);
    for (const c of brief.struck) lines.push(`  STRUCK [${c.claim.cites.join(",")}] ${c.claim.text}; ${c.reason}`);
  }
  const r = bundle.ruling;
  lines.push(`Ruling: ${r.side}, size=${r.sizeBps} bps, entryE8=${r.entryE8}, stopE8=${r.stopE8}, targetE8=${r.targetE8}, horizon=${r.horizonSec}s, score=${r.score}`,
    r.summary, "Verified: canonical hash, config, citations, signals, ruling.");
  return lines.join("\n");
}

export async function replay(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { offline: { type: "boolean" } } });
  if (positionals.length !== 1) throw new Error("Usage: npm run replay -- <caseId | bundleHash | path> [--offline]");
  const { config } = await loadConfig();
  const arg = positionals[0]!;
  let id: bigint | undefined;
  let expectedHash: string | undefined;
  let chainCase: LedgerCase | undefined;
  const ledger = values.offline ? undefined : await connectLedger(config);
  if (/^[1-9][0-9]*$/.test(arg)) {
    id = BigInt(arg);
    if (ledger) { chainCase = await ledger.getCase(id); expectedHash = chainCase.bundleHash; }
    else {
      const index = JSON.parse(await readFile(await workspacePath(resolve(ROOT, "cases/index.json")), "utf8")) as { id: string; bundleHash: string }[];
      expectedHash = index.find(item => String(item.id) === arg)?.bundleHash;
      if (!expectedHash) throw new Error("Case ID absent from local index; use a hash or path offline");
    }
  } else if (/^0x[0-9a-fA-F]{64}$/.test(arg)) expectedHash = arg.toLowerCase();
  else {
    const match = /^(0x[0-9a-fA-F]{64})\.json$/.exec(basename(arg));
    expectedHash = match?.[1]?.toLowerCase();
  }
  const path = await workspacePath(expectedHash && (id !== undefined || /^0x[0-9a-fA-F]{64}$/.test(arg))
    ? resolve(ROOT, "cases", `${expectedHash}.json`) : resolve(arg));
  let bytes: string;
  if (await exists(path)) bytes = await readFile(path, "utf8");
  else if (expectedHash && process.env.CASEFILE_BUNDLE_BASE) {
    const base = process.env.CASEFILE_BUNDLE_BASE.replace(/\/?$/, "/");
    const response = await fetch(new URL(`${expectedHash}.json`, base), { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Bundle download HTTP ${response.status}`);
    bytes = await response.text();
  } else throw new Error(`Bundle not found: ${path}`);
  const verified = verifyBundle(bytes, config, expectedHash);
  if (ledger) {
    if (!chainCase) {
      // Bundle lookup does not require a local index or the configured agent's key.
      for (const candidate of await ledger.casesOf(verified.bundle.agent)) {
        const c = await ledger.getCase(candidate);
        if (c.bundleHash === verified.hash) { chainCase = c; break; }
      }
    }
    if (!chainCase) throw new Error("Bundle is not sealed in this ledger");
    verifyChain(verified.bundle, verified.hash, chainCase);
  }
  console.log(replayTrail(verified.bundle, verified.hash));
  console.log(values.offline ? "Offline replay matched." : "On-chain opening fields matched.");
}
if (isMain(import.meta.url)) await cli(replay);
