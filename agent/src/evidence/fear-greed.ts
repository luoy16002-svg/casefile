import { z } from "zod";
import type { FngItem, Exhibit } from "../types.js";
import { fetchExhibit, type EvidenceOptions } from "./http.js";

export function normalizeFearGreed(raw: string): FngItem[] {
  const response = z.object({ data: z.array(z.object({ timestamp: z.coerce.number().int().nonnegative(),
    value: z.coerce.number().int().min(0).max(100) })).min(1) }).parse(JSON.parse(raw));
  return response.data.map(({ timestamp, value }) => ({ timestamp, value }))
    .sort((a, b) => a.timestamp - b.timestamp || a.value - b.value).slice(-14);
}
export function fetchFearGreed(id: string, options: EvidenceOptions = {}): Promise<Exhibit> {
  return fetchExhibit({ id, kind: "fear_greed", source: "Alternative.me", method: "GET",
    url: "https://api.alternative.me/fng/?limit=14" }, normalizeFearGreed, options);
}
