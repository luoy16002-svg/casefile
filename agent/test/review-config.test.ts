import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ledger from "../src/ledger.js";
import * as replay from "../src/replay.js";
import * as coinbase from "../src/evidence/coinbase.js";
import * as bundles from "../src/bundle.js";
import * as configs from "../src/config.js";
import { review } from "../src/review.js";
import { ROOT } from "../src/paths.js";
import { bundleSchema } from "../src/schemas.js";
import { config, fixture, ledgerCase } from "./helpers.js";

const hash = "0xe0a523498be468e45e49c2a2e879a2b91c5c9188ec52b31a53ae99cb0a566801";
const originalBytes = readFileSync(resolve(ROOT, "cases", `${hash}.json`), "utf8");
const opening = bundleSchema.parse(JSON.parse(originalBytes));
const r = opening.ruling;
const c = ledgerCase({ agent: opening.agent, bundleHash: hash, asset: ledger.assetBytes(opening.asset),
  side: ledger.sideNumber[r.side], sizeBps: r.sizeBps, entryE8: BigInt(r.entryE8), stopE8: BigInt(r.stopE8),
  targetE8: BigInt(r.targetE8), horizon: r.horizonSec, openedAt: 3600n });
const close = vi.fn();
let argv: string[];

beforeEach(() => {
  argv = process.argv;
  process.argv = ["node", "review", "--dry-run"];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(ledger, "agentAddress").mockReturnValue(opening.agent);
  vi.spyOn(ledger, "connectLedger").mockResolvedValue({
    getCase: vi.fn().mockResolvedValue(c), casesOf: vi.fn().mockResolvedValue([1n]),
    now: vi.fn().mockResolvedValue(3600 + r.horizonSec), open: vi.fn(), close
  });
  const e = fixture().exhibits[0]!;
  vi.spyOn(coinbase, "fetchReviewCandles").mockResolvedValue([{ ...e, data: [[3600, 99, 101, 100, 100, 1]] }]);
  vi.spyOn(bundles, "saveBundle").mockResolvedValue(`0x${"1".repeat(64)}`);
});
afterEach(() => { process.argv = argv; vi.restoreAllMocks(); close.mockClear(); });

describe("review config selection", () => {
  it("reviews a legacy opening using its archived config even if the current assets changed", async () => {
    const current = structuredClone(config); current.assets = ["SOL"];
    vi.spyOn(configs, "loadConfig").mockResolvedValue({ config: current, configHash: bundles.hashBundle(current) });
    await review();
    expect(coinbase.fetchReviewCandles).toHaveBeenCalledWith("BTC", 3600, expect.any(Number));
    expect(bundles.saveBundle).toHaveBeenCalledWith(expect.objectContaining({ bundleHash: hash, reason: "Horizon" }), resolve(ROOT, "agent/tmp/reviews"));
    expect(close).not.toHaveBeenCalled();
  });
  it("fails clearly before price lookup when an opening config is missing", async () => {
    const missing = structuredClone(opening); missing.configHash = `0x${"0".repeat(64)}`;
    vi.spyOn(replay, "loadBundleBytes").mockResolvedValue(bundles.canonicalJson(missing));
    await expect(review()).rejects.toThrow("1 case review(s) failed");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`No config found for ${missing.configHash}`));
    expect(coinbase.fetchReviewCandles).not.toHaveBeenCalled();
    expect(bundles.saveBundle).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
