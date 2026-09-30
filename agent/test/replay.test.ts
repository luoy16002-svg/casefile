import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, hashBundle } from "../src/bundle.js";
import { replayTrail, verifyBundle, verifyBundleWithConfig, verifyChain } from "../src/replay.js";
import { ROOT } from "../src/paths.js";
import { assetBytes, sideNumber } from "../src/ledger.js";
import { config, fixtureBundle, ledgerCase } from "./helpers.js";
import { buildDebate } from "../src/debate.js";
import { judge } from "../src/judge.js";

describe("replay", () => {
  it.each(readdirSync(resolve(ROOT, "cases")).filter(name => /^0x[0-9a-f]{64}\.json$/.test(name)))
    ("replays the existing bundle %s with its archived config", async name => {
      const bytes = readFileSync(resolve(ROOT, "cases", name), "utf8");
      const verified = await verifyBundleWithConfig(bytes, name.slice(0, -5), config);
      expect(verified.hash).toBe(name.slice(0, -5));
      expect(hashBundle(verified.config)).toBe(verified.bundle.configHash);
      expect(verified.config.llm.provider).toBe(verified.config.llm.model.startsWith("qwen") ? "ollama" : "github-models");
      expect(verified.bundle.debate).toEqual(JSON.parse(bytes).debate);
      // Cases opened before structured output (GitHub Models, qwen2.5:3b) carry neither field; later model briefs carry both.
      const structured = verified.config.llm.provider === "ollama" && verified.config.llm.model !== "qwen2.5:3b";
      for (const brief of [verified.bundle.debate.bull, verified.bundle.debate.bear]) {
        if (structured && brief.mode === "llm") {
          expect(brief).toHaveProperty("responseFormat");
          expect(typeof brief.normalized).toBe("boolean");
        } else if (!structured) {
          expect(brief).not.toHaveProperty("responseFormat");
          expect(brief).not.toHaveProperty("normalized");
        }
      }
    });
  it("replays new structured briefs with normalized claims and preserved strike reasons", async () => {
    const bundle = await fixtureBundle();
    const content = JSON.stringify({ claims: [
      { text: "Hourly return", cites: " e1 " },
      { text: "Unknown citation", cites: ["e99"] }
    ], strength: 0.5 });
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async url => new Response(JSON.stringify(
      String(url).endsWith("/api/tags") ? { models: [] } : { message: { content } }
    )));
    bundle.debate = await buildDebate(bundle.exhibits, bundle.signals, config, { fetchFn });
    bundle.ruling = judge(bundle.signals, bundle.debate, bundle.exhibits, config);
    const verified = await verifyBundleWithConfig(canonicalJson(bundle), hashBundle(bundle));
    expect(verified.bundle.debate).toEqual(bundle.debate);
    expect(verified.bundle.debate.bull).toMatchObject({ mode: "llm", normalized: true });
    expect(verified.bundle.debate.bull.responseFormat).toBeDefined();
    expect(verified.bundle.debate.bull.struck[0]!.reason).toBe("Unknown exhibit E99");
    bundle.debate.bull.struck[0]!.reason = "Rewritten reason";
    expect(() => verifyBundle(canonicalJson(bundle), config)).toThrow("struck-claim validation mismatch");
  });
  it("replays new briefs with a digest and rejects an unknown config hash", async () => {
    const bundle = await fixtureBundle();
    bundle.debate.bull.modelDigest = "b".repeat(64);
    bundle.debate.bear.modelDigest = null;
    const verified = await verifyBundleWithConfig(canonicalJson(bundle), hashBundle(bundle));
    expect(verified.bundle.debate).toEqual(bundle.debate);
    bundle.configHash = `0x${"0".repeat(64)}`;
    await expect(verifyBundleWithConfig(canonicalJson(bundle))).rejects.toThrow("No config found");
  });
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
