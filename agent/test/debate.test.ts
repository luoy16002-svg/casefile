import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDebate, modelOutputSchema, templateBrief, validateClaims } from "../src/debate.js";
import { canonicalJson } from "../src/bundle.js";
import { config, fixture, testSignals } from "./helpers.js";
import { computeSignals } from "../src/signals.js";

afterEach(() => vi.unstubAllEnvs());
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
  it("calls GitHub Models with bearer auth, configured model, temperature and JSON format", async () => {
    const content = JSON.stringify({ claims: [{ text: "Hourly evidence supports this claim", cites: ["E1"], signal: "ret_24h" }], strength: 0.7 });
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }));
    const { exhibits } = fixture();
    const d = await buildDebate(exhibits, computeSignals(exhibits), config, { token: "mock-token", fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://models.github.ai/inference/chat/completions");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer mock-token" });
    expect(JSON.parse(init!.body as string)).toMatchObject({ model: "openai/gpt-4.1-mini", temperature: 0, response_format: { type: "json_object" } });
    expect(d.bull).toMatchObject({ mode: "llm", model: config.llm.model, rawResponse: content, strength: 0.7 });
    expect(d.bull.claims).toHaveLength(1); expect(d.bull.struck).toEqual([]);
  });
  it("falls back on HTTP failure and records the error", async () => {
    const { exhibits } = fixture();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => new Response("blocked", { status: 403 }));
    const d = await buildDebate(exhibits, computeSignals(exhibits), config, { token: "mock-token", fetchFn });
    expect(d.bull.mode).toBe("template"); expect(d.bull.error).toBe("GitHub Models HTTP 403");
  });
  it("preserves malformed LLM text when falling back and supports GITHUB_TOKEN", async () => {
    vi.stubEnv("MODELS_TOKEN", undefined); vi.stubEnv("GITHUB_TOKEN", "mock-fallback-token");
    const { exhibits } = fixture();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: "not JSON" } }] })));
    const d = await buildDebate(exhibits, computeSignals(exhibits), config, { fetchFn });
    expect(d.bull).toMatchObject({ mode: "template", rawResponse: "not JSON", model: config.llm.model });
    expect(d.bull.error).toBeTruthy();
    expect(fetchFn.mock.calls[0]![1]?.headers).toMatchObject({ Authorization: "Bearer mock-fallback-token" });
  });
  it("enforces model output size and strength", () => {
    expect(modelOutputSchema.safeParse({ claims: [{ text: "x".repeat(241), cites: [], signal: null }], strength: 0.5 }).success).toBe(false);
    expect(modelOutputSchema.safeParse({ claims: [], strength: 1.1 }).success).toBe(false);
    expect(modelOutputSchema.safeParse({ claims: Array.from({ length: 6 }, () => ({ text: "x", cites: ["E1"], signal: null })), strength: 0 }).success).toBe(false);
  });
});
