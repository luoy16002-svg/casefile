import { z } from "zod";
import type { Bundle, Exhibit, ResponseFormat } from "./types.js";

const hash = z.string().regex(/^0x[0-9a-f]{64}$/).transform(s => s as `0x${string}`);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(s => s as `0x${string}`);
const e8 = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(s => BigInt(s) <= 18446744073709551615n);
const candle = z.tuple([z.number().int().nonnegative(), z.number().nonnegative(), z.number().positive(), z.number().positive(), z.number().positive(), z.number().nonnegative()]);
const base = {
  id: z.string().regex(/^E[1-9][0-9]*$/), source: z.string().min(1), url: z.url(), method: z.enum(["GET", "POST"]),
  requestBody: z.unknown().optional(), fetchedAt: z.iso.datetime(), status: z.enum(["ok", "unavailable"]),
  error: z.string().optional(), responseSha256: z.string().regex(/^[0-9a-f]{64}$/)
};
const rawExhibitSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("candles_1h"), data: z.array(candle).nullable() }).strict(),
  z.object({ ...base, kind: z.literal("candles_1d"), data: z.array(candle).nullable() }).strict(),
  z.object({ ...base, kind: z.literal("hyperliquid"), data: z.object({ funding: z.string(), openInterest: z.string(), markPx: z.string(),
    oraclePx: z.string(), premium: z.string(), dayNtlVlm: z.string() }).strict().nullable() }).strict(),
  z.object({ ...base, kind: z.literal("fear_greed"), data: z.array(z.object({ timestamp: z.number().int().nonnegative(), value: z.number().int().min(0).max(100) }).strict()).nullable() }).strict(),
  z.object({ ...base, kind: z.literal("news"), data: z.array(z.object({ title: z.string(), link: z.url(), pubDate: z.iso.datetime(), source: z.string() }).strict()).nullable() }).strict()
]).superRefine((e, ctx) => {
  if ((e.status === "ok") !== (e.data !== null)) ctx.addIssue({ code: "custom", message: "Exhibit status and data disagree" });
});
export const exhibitSchema: z.ZodType<Exhibit> = rawExhibitSchema;
const signal = z.object({ name: z.string(), value: z.number().finite().nullable(), unit: z.string(), exhibits: z.array(z.string()), note: z.string() }).strict();
const claim = z.object({ text: z.string().min(1).max(240), cites: z.array(z.string()), signal: z.string().nullable() }).strict();
export const responseFormatSchema: z.ZodType<ResponseFormat> = z.object({
  type: z.literal("object"),
  properties: z.object({
    claims: z.object({ type: z.literal("array"), maxItems: z.literal(5), items: z.object({
      type: z.literal("object"), properties: z.object({
        text: z.object({ type: z.literal("string"), maxLength: z.literal(240) }).strict(),
        cites: z.object({ type: z.literal("array"), minItems: z.literal(1), maxItems: z.literal(7),
          items: z.object({ type: z.literal("string"), enum: z.array(z.string()) }).strict() }).strict(),
        signal: z.object({ anyOf: z.array(z.union([
          z.object({ type: z.literal("string"), enum: z.array(z.string()) }).strict(),
          z.object({ type: z.literal("null") }).strict()
        ])).min(1) }).strict()
      }).strict(), required: z.array(z.string())
    }).strict() }).strict(),
    strength: z.object({ type: z.literal("number"), minimum: z.literal(0), maximum: z.literal(1) }).strict()
  }).strict(), required: z.array(z.string())
}).strict();
const brief = z.object({ mode: z.enum(["llm", "template"]), model: z.string(), prompt: z.string(), rawResponse: z.string(),
  modelDigest: z.string().regex(/^(sha256:)?[0-9a-f]{64}$/).nullable().optional(),
  responseFormat: responseFormatSchema.optional(), normalized: z.boolean().optional(),
  claims: z.array(claim).max(5), struck: z.array(z.object({ claim, reason: z.string() }).strict()).max(5),
  strength: z.number().finite().min(0).max(1), error: z.string().optional() }).strict();
const ruling = z.object({ side: z.enum(["Flat", "Long", "Short"]), sizeBps: z.number().int().min(0).max(10000),
  entryE8: e8, stopE8: e8, targetE8: e8, horizonSec: z.number().int().min(3600).max(2592000), score: z.number().min(-1).max(1),
  contributions: z.array(z.object({ rule: z.string(), vote: z.number().min(-1).max(1), weight: z.number().nonnegative(),
    inputs: z.array(z.string()), reason: z.string() }).strict()), summary: z.string() }).strict();

export const bundleSchema: z.ZodType<Bundle> = z.object({
  schema: z.literal("casefile/1"), agent: address, asset: z.enum(["BTC", "ETH", "SOL"]), createdAt: z.iso.datetime(),
  judgeVersion: z.string(), configHash: hash, codeRef: z.string(), exhibits: z.array(exhibitSchema),
  signals: z.array(signal), debate: z.object({ bull: brief, bear: brief }).strict(), ruling
}).strict().superRefine((bundle, ctx) => {
  if (new Set(bundle.exhibits.map(e => e.id)).size !== bundle.exhibits.length)
    ctx.addIssue({ code: "custom", message: "Duplicate exhibit IDs" });
  if (new Set(bundle.signals.map(s => s.name)).size !== bundle.signals.length)
    ctx.addIssue({ code: "custom", message: "Duplicate signal names" });
});
