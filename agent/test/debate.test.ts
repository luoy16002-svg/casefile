import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDebate, modelOutputSchema, templateBrief, validateClaims } from "../src/debate.js";
import { canonicalJson } from "../src/bundle.js";
import { config, fixture, testSignals } from "./helpers.js";
import { computeSignals } from "../src/signals.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const digest = "a".repeat(64);
const tags = () => new Response(JSON.stringify({ models: [{ name: "qwen2.5:3b", digest }] }));
const chat = (content: string) => new Response(JSON.stringify({ message: { content } }));
describe("debate", () => {
  it("strikes absent, unknown and unavailable citations, and unknown signal names", () => {
    const { exhibits } = fixture(); exhibits[2] = { ...exhibits[2]!, status: "unavailable", data: null, error: "test" };
    const claims = [
      { text: "valid", cites: ["E1"], signal: "rsi14_1h" },
      { text: "no cites", cites: [], signal: null },
      { text: "unknown", cites: ["E99"], signal: null },
      { text: "unavailable", cites: ["E3"], signal: null },
      { text: "wrong signal", cites: ["E1"], signal: "imaginary" }
    ];
    const result = validateClaims(claims, exhibits, computeSignals(exhibits));
    expect(result.claims).toEqual([claims[0]]); expect(result.struck).toHaveLength(4);
    expect(result.struck.map(s => s.reason)).toEqual(["No exhibit citations", "Unknown exhibit E99", "Unavailable exhibit E3", "Unknown signal imaginary"]);
  });
  it("makes deterministic, honestly sided template claims", () => {
    const signals = testSignals({ rsi14_1h: 78, ret_24h: 2, price_vs_sma20d_pct: 1 });
    const exhibits = fixture().exhibits;
    const bull = templateBrief("bull", signals, exhibits, "prompt");
    const bear = templateBrief("bear", signals, exhibits, "prompt");
    expect(bull.claims.some(c => c.signal === "ret_24h")).toBe(true);
    expect(bear.claims.some(c => c.signal === "rsi14_1h")).toBe(true);
    expect(bull.mode).toBe("template"); expect(bull.struck).toEqual([]);
    expect(canonicalJson(bull)).toBe(canonicalJson(templateBrief("bull", signals, exhibits, "prompt")));
  });
  it("uses identical evidence input for both roles and never calls the provider for none", async () => {
    const c = structuredClone(config); c.llm.provider = "none";
    const fetchFn = vi.fn<typeof fetch>(); const { exhibits } = fixture();
    const d = await buildDebate(exhibits, computeSignals(exhibits), c, { fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(d.bull.prompt.split("SIGNALS\n")[1]).toBe(d.bear.prompt.split("SIGNALS\n")[1]);
  });
  it("calls native Ollama with the configured model, JSON format, seed, timeout and exact digest", async () => {
    vi.stubEnv("OLLAMA_URL", undefined);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const content = JSON.stringify({ claims: [{ text: "Hourly evidence supports this claim", cites: ["E1"], signal: "ret_24h" }], strength: 0.7 });
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith("/api/tags") ? tags() : chat(content));
    const { exhibits } = fixture();
    const d = await buildDebate(exhibits, computeSignals(exhibits), config, { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(4);
    const [url, init] = fetchFn.mock.calls[1]!;
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(init?.headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(init!.body as string)).toEqual({ model: "qwen2.5:3b", messages: [{ role: "user", content: d.bull.prompt }],
      format: "json", stream: false, options: { temperature: 0, seed: 42 } });
    expect(timeout.mock.calls).toEqual([[300_000], [300_000], [300_000], [300_000]]);
    expect(d.bull).toMatchObject({ mode: "llm", model: config.llm.model, modelDigest: digest, rawResponse: content, strength: 0.7 });
    expect(d.bear.modelDigest).toBe(digest);
    expect(d.bull.claims).toHaveLength(1); expect(d.bull.struck).toEqual([]);
  });
  it("uses OLLAMA_URL and finishes bull before starting bear", async () => {
    vi.stubEnv("OLLAMA_URL", "http://local-ollama:1234/");
    let release!: (response: Response) => void;
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<Response>(resolve => { release = resolve; });
    let calls = 0;
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async url => {
      if (String(url).endsWith("/api/tags")) return tags();
      calls++;
      if (calls === 1) { started(); return pending; }
      return chat('{"claims":[],"strength":0}');
    });
    const { exhibits } = fixture();
    const result = buildDebate(exhibits, computeSignals(exhibits), config, { fetchFn });
    await firstStarted;
    expect(calls).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    release(chat('{"claims":[],"strength":0}'));
    const d = await result;
    expect(calls).toBe(2);
    expect(d.bear.mode).toBe("llm");
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      "http://local-ollama:1234/api/tags", "http://local-ollama:1234/api/chat",
      "http://local-ollama:1234/api/tags", "http://local-ollama:1234/api/chat"
    ]);
  });
  it("falls back on HTTP failure and records the error", async () => {
    const { exhibits } = fixture();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => new Response("blocked", { status: 403 }));
    const d = await buildDebate(exhibits, computeSignals(exhibits), config, { fetchFn });
    for (const brief of [d.bull, d.bear]) expect(brief).toMatchObject({ mode: "template", error: "Ollama HTTP 403", rawResponse: "blocked" });
  });
  it.each(["not JSON", "", '{"claims":[],"strength":2}'])("preserves malformed model content %j when falling back", async content => {
    const { exhibits } = fixture();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith("/api/tags") ? tags() : chat(content));
    const d = await buildDebate(exhibits, computeSignals(exhibits), config, { fetchFn });
    expect(d.bull).toMatchObject({ mode: "template", rawResponse: content, model: config.llm.model, modelDigest: digest });
    expect(d.bull.error).toBeTruthy();
  });
  it.each(["OK\r\n", '{"message":{}}'])("preserves a malformed API envelope %j", async raw => {
    const { exhibits } = fixture();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith("/api/tags") ? tags() : new Response(raw));
    const d = await buildDebate(exhibits, computeSignals(exhibits), config, { fetchFn });
    expect(d.bull).toMatchObject({ mode: "template", rawResponse: raw });
    expect(d.bull.error).toBeTruthy();
  });
  it.each(["http", "network", "json", "absent", "digest"])("records null without aborting when digest lookup fails: %s", async failure => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async url => {
      if (!String(url).endsWith("/api/tags")) return chat('{"claims":[],"strength":0.5}');
      if (failure === "network") throw new Error("offline");
      if (failure === "http") return new Response("failed", { status: 500 });
      if (failure === "json") return new Response("invalid");
      return new Response(JSON.stringify({ models: failure === "absent" ? [] : [{ name: config.llm.model, digest: "invalid" }] }));
    });
    const { exhibits } = fixture();
    const d = await buildDebate(exhibits, computeSignals(exhibits), config, { fetchFn });
    for (const brief of [d.bull, d.bear]) expect(brief).toMatchObject({ mode: "llm", modelDigest: null, strength: 0.5 });
  });
  it("falls back on a chat timeout", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async url => {
      if (String(url).endsWith("/api/tags")) return tags();
      throw new DOMException("Inference timed out", "TimeoutError");
    });
    const { exhibits } = fixture();
    const d = await buildDebate(exhibits, computeSignals(exhibits), config, { fetchFn });
    expect(d.bull).toMatchObject({ mode: "template", error: "Inference timed out", modelDigest: digest });
  });
  it("records the GitHub Models retirement reason without fetching or requiring a key", async () => {
    const c = structuredClone(config); c.llm = { provider: "github-models", model: "openai/gpt-4.1-mini", temperature: 0 };
    const fetchFn = vi.fn<typeof fetch>(); const { exhibits } = fixture();
    const d = await buildDebate(exhibits, computeSignals(exhibits), c, { fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    for (const brief of [d.bull, d.bear]) expect(brief).toMatchObject({ mode: "template", model: c.llm.model, error: "GitHub Models was retired on 2026-07-30" });
  });
  it("enforces model output size and strength", () => {
    expect(modelOutputSchema.safeParse({ claims: [{ text: "x".repeat(241), cites: [], signal: null }], strength: 0.5 }).success).toBe(false);
    expect(modelOutputSchema.safeParse({ claims: [], strength: 1.1 }).success).toBe(false);
    expect(modelOutputSchema.safeParse({ claims: Array.from({ length: 6 }, () => ({ text: "x", cites: ["E1"], signal: null })), strength: 0 }).success).toBe(false);
  });
});
