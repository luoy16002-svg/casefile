import { describe, expect, it } from "vitest";
import { canonicalJson, hashBundle } from "../src/bundle.js";
import { replayTrail, verifyBundle, verifyChain } from "../src/replay.js";
import { assetBytes, sideNumber } from "../src/ledger.js";
import { config, fixtureBundle, ledgerCase } from "./helpers.js";

describe("replay", () => {
  it.each(["BTC", "ETH", "SOL"] as const)("replays a fixture bundle for %s exactly", async asset => {
    const bundle = await fixtureBundle(asset);
    const hash = hashBundle(bundle);
    const verified = verifyBundle(canonicalJson(bundle), config, hash);
    expect(verified.hash).toBe(hash); expect(verified.bundle).toEqual(bundle);
    expect(replayTrail(bundle, hash)).toContain("Rule contributions:");
  });
  it("rejects a one-byte change and noncanonical bytes", async () => {
    const bundle = await fixtureBundle(); const bytes = canonicalJson(bundle);
    expect(() => verifyBundle(bytes.replace('"local"', '"Local"'), config, hashBundle(bundle))).toThrow("Bundle hash mismatch");
    expect(() => verifyBundle(`${bytes}\n`, config)).toThrow("not canonical");
  });
  it("rejects changed signals and a changed ruling even if rehashed", async () => {
    const bundle = await fixtureBundle(); bundle.signals[0]!.value = 123;
    expect(() => verifyBundle(canonicalJson(bundle), config)).toThrow("Signals mismatch");
    const other = await fixtureBundle(); other.ruling.sizeBps += 1;
    expect(() => verifyBundle(canonicalJson(other), config)).toThrow("Ruling mismatch");
  });
  it("checks the config hash and judge version", async () => {
    const bundle = await fixtureBundle(); const c = structuredClone(config); c.risk.maxSizeBps = 1000;
    expect(() => verifyBundle(canonicalJson(bundle), c)).toThrow("Config hash mismatch");
    bundle.judgeVersion = "2";
    expect(() => verifyBundle(canonicalJson(bundle), config)).toThrow("Unsupported judge version");
  });
  it("matches every opening field to the chain record", async () => {
    const bundle = await fixtureBundle(); const r = bundle.ruling; const hash = hashBundle(bundle);
    const c = ledgerCase({ agent: bundle.agent, bundleHash: hash, asset: assetBytes(bundle.asset), side: sideNumber[r.side],
      sizeBps: r.sizeBps, entryE8: BigInt(r.entryE8), stopE8: BigInt(r.stopE8), targetE8: BigInt(r.targetE8), horizon: r.horizonSec });
    expect(() => verifyChain(bundle, hash, c)).not.toThrow();
    expect(() => verifyChain(bundle, hash, { ...c, entryE8: c.entryE8 + 1n })).toThrow("opening fields mismatch");
    expect(() => verifyChain(bundle, hash, { ...c, bundleHash: `0x${"0".repeat(64)}` })).toThrow("bundle hash mismatch");
  });
});
