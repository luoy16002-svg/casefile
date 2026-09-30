import { z } from "zod";
import type { Asset, HyperData, Exhibit } from "../types.js";
import { fetchExhibit, type EvidenceOptions } from "./http.js";

const decimal = z.union([z.string(), z.number()]).transform(value => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Non-finite Hyperliquid decimal");
  return number.toFixed(12);
});
const contextSchema = z.object({ funding: decimal, openInterest: decimal, markPx: decimal,
  oraclePx: decimal, premium: decimal, dayNtlVlm: decimal });
export function normalizeHyperliquid(raw: string, asset: Asset): HyperData {
  const response = z.tuple([z.object({ universe: z.array(z.object({ name: z.string() })) }), z.array(z.unknown())]).parse(JSON.parse(raw));
  const index = response[0].universe.findIndex(item => item.name === asset);
  if (index < 0) throw new Error(`Hyperliquid asset missing: ${asset}`);
  return contextSchema.parse(response[1][index]);
}
export function fetchHyperliquid(asset: Asset, id: string, options: EvidenceOptions = {}): Promise<Exhibit> {
  return fetchExhibit({ id, kind: "hyperliquid", source: "Hyperliquid", method: "POST",
    url: "https://api.hyperliquid.xyz/info", requestBody: { type: "metaAndAssetCtxs" } },
  raw => normalizeHyperliquid(raw, asset), options);
}
