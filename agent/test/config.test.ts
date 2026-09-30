import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIGS_DIR, configSchema, loadConfig, loadConfigForHash, saveConfig } from "../src/config.js";
import { canonicalJson, hashBundle } from "../src/bundle.js";
import { ROOT } from "../src/paths.js";
import { config } from "./helpers.js";

let directory: string;
beforeEach(async () => {
  await mkdir(resolve(ROOT, "tmp"), { recursive: true });
  directory = await mkdtemp(resolve(ROOT, "tmp", "config-test-"));
});
afterEach(async () => { await rm(directory, { recursive: true }); vi.unstubAllEnvs(); });

describe("config archives", () => {
  it("loads a historical config by its hash instead of using the changed current config", async () => {
    const old = structuredClone(config);
    old.llm = { provider: "github-models", model: "openai/gpt-4.1-mini", temperature: 0 };
    await saveConfig(old, directory);
    expect(await loadConfigForHash(hashBundle(old), config, directory)).toEqual(old);
  });
  it("loads the current and all three historical configs as exact canonical bytes", async () => {
    for (const hash of [hashBundle(config), "0x2466aa5a79312b2b6f11588330beea6ae3b3e07e0e59471e6d9a7eba459b14b6",
      "0x2e2c39c97ae95d6dc932ffc0a69ab69193b8a9e553e70cb8534e105dc7f8e66c",
      "0xc75562980da71c0cc7ce161b194a32651d6996418f7c88c09d236496fe5a60a8"]) {
      const loaded = await loadConfigForHash(hash);
      expect(await readFile(resolve(CONFIGS_DIR, `${hash}.json`), "utf8")).toBe(canonicalJson(loaded));
      expect(hashBundle(loaded)).toBe(hash);
    }
  });
  it("changes only the direction-check setting from the Phase 4 config", async () => {
    const previous = await loadConfigForHash("0xc75562980da71c0cc7ce161b194a32651d6996418f7c88c09d236496fe5a60a8");
    expect(config).toEqual({ ...previous, debate: { directionCheck: "v1" } });
  });
  it("rejects unsupported direction-check versions", () => {
    expect(configSchema.safeParse({ ...config, debate: { directionCheck: "v2" } }).success).toBe(false);
  });
  it("falls back to the current config only when its hash matches", async () => {
    expect(await loadConfigForHash(hashBundle(config), config, directory)).toEqual(config);
    const other = structuredClone(config); other.horizonHours++;
    await expect(loadConfigForHash(hashBundle(other), config, directory)).rejects.toThrow(`No config found for ${hashBundle(other)}`);
  });
  it("rejects a mismatched archive and an invalid hash", async () => {
    const other = structuredClone(config); other.horizonHours++;
    await writeFile(resolve(directory, `${hashBundle(other)}.json`), canonicalJson(config));
    await expect(loadConfigForHash(hashBundle(other), config, directory)).rejects.toThrow("Archived config hash mismatch");
    await expect(loadConfigForHash("../config", config, directory)).rejects.toThrow("Invalid config hash");
  });
  it("saves a new config once and refuses to replace different existing bytes", async () => {
    const path = resolve(directory, `${hashBundle(config)}.json`);
    await saveConfig(config, directory);
    const before = await readFile(path, "utf8");
    await saveConfig(config, directory);
    expect(await readFile(path, "utf8")).toBe(before);
    await writeFile(path, "{}");
    await expect(saveConfig(config, directory)).rejects.toThrow("Refusing to overwrite");
  });
  it("keeps environment connection overrides out of the config hash", async () => {
    const before = await loadConfig();
    vi.stubEnv("OLLAMA_URL", "http://another-server:11434");
    vi.stubEnv("RPC_URL", "http://another-rpc:8545");
    vi.stubEnv("CHAIN_ID", "123");
    expect(await loadConfig()).toEqual(before);
  });
});
