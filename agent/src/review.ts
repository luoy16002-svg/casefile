import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { hexToString } from "viem";
import { loadConfig } from "./config.js";
import { fetchReviewCandles } from "./evidence/coinbase.js";
import { agentAddress, connectLedger } from "./ledger.js";
import { priceE8 } from "./numbers.js";
import { saveBundle } from "./bundle.js";
import { ROOT } from "./paths.js";
import type { Asset, Candle, CloseReason, Exhibit, LedgerCase, ReviewBundle } from "./types.js";
import { errorMessage } from "./evidence/http.js";
import { cli, isMain } from "./cli.js";

export function detectClose(c: LedgerCase, candles: Candle[], now: number): { reason: CloseReason; exitE8: bigint } | null {
  if (c.reason !== 0) return null;
  // A candle that began before entry may contain a pre-entry stop/target hit.
  const rows = candles.filter(row => row[0] + 3600 > Number(c.openedAt) && row[0] <= now).sort((a, b) => a[0] - b[0]);
  for (const row of rows) {
    if (c.side === 0) break;
    if (row[0] < Number(c.openedAt)) continue;
    const low = row[1] === 0 ? 0n : priceE8(row[1]);
    const high = priceE8(row[2]);
    const stopHit = c.side === 1 ? low <= c.stopE8 : high >= c.stopE8;
    const targetHit = c.side === 1 ? high >= c.targetE8 : low <= c.targetE8;
    if (stopHit) return { reason: "Stop", exitE8: c.stopE8 };
    if (targetHit) return { reason: "Target", exitE8: c.targetE8 };
  }
  const latest = rows.at(-1);
  if (latest && now >= Number(c.openedAt) + c.horizon) return { reason: "Horizon", exitE8: priceE8(latest[4]) };
  return null;
}

export function reviewCandles(exhibits: Exhibit[]): Candle[] | null {
  if (exhibits.length === 0 || exhibits.some(e => e.status !== "ok" || e.kind !== "candles_1h")) return null;
  const byTime = new Map<number, Candle>();
  for (const e of exhibits) for (const row of e.data as Candle[]) byTime.set(row[0], row);
  const rows = [...byTime.values()].sort((a, b) => a[0] - b[0]);
  if (rows.some((row, i) => i > 0 && row[0] - rows[i - 1]![0] !== 3600)) return null;
  return rows;
}

export async function review(): Promise<void> {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean" } } });
  const dry = values["dry-run"] ?? false;
  const { config } = await loadConfig();
  const agent = agentAddress();
  const ledger = await connectLedger(config, !dry);
  const ids = await ledger.casesOf(agent);
  const now = await ledger.now();
  let failures = 0;
  let open = 0;
  let due = 0;
  let closed = 0;
  for (const id of ids) {
    try {
      const c = await ledger.getCase(id);
      if (c.reason !== 0) continue;
      open++;
      const asset = hexToString(c.asset, { size: 32 }).replace(/\0+$/, "") as Asset;
      if (!config.assets.includes(asset)) throw new Error(`Unsupported asset ${asset}`);
      // Chain time may be warped in tests; public API windows use actual market time.
      const marketNow = Math.floor(Date.now() / 1000);
      const exhibits = await fetchReviewCandles(asset, Number(c.openedAt), marketNow);
      const candles = reviewCandles(exhibits);
      if (!candles) throw new Error("Review candle evidence is unavailable or has gaps; case left open");
      const decision = detectClose(c, candles, now);
      if (!decision) { console.log(`Case ${id}: still open (no trigger or no post-entry candle)`); continue; }
      due++;
      const bundle: ReviewBundle = { schema: "casefile-review/1", caseId: id.toString(), bundleHash: c.bundleHash,
        reason: decision.reason, exitE8: decision.exitE8.toString(), exhibits };
      const hash = await saveBundle(bundle, resolve(ROOT, dry ? "agent/tmp/reviews" : "reviews"));
      console.log(`Case ${id}: ${decision.reason}, exitE8=${decision.exitE8}, reviewHash=${hash}${dry ? " (dry-run)" : ""}`);
      if (!dry) {
        console.log(`Closed case ${id}, tx=${await ledger.close(id, decision.exitE8, decision.reason, hash)}`);
        closed++;
      }
    } catch (error) { failures++; console.error(`Case ${id}: ${errorMessage(error)}`); }
  }
  console.log(`Reviewed ${open} open case(s): ${due} due, ${closed} closed${dry ? " (dry-run)" : ""}, ${failures} failed.`);
  if (failures) throw new Error(`${failures} case review(s) failed`);
}
if (isMain(import.meta.url)) await cli(review);
