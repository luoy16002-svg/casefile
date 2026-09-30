import { createHash } from "node:crypto";
import type { Exhibit } from "../types.js";

export type Fetch = typeof globalThis.fetch;
export interface EvidenceOptions { fetchFn?: Fetch; now?: number }
export const USER_AGENT = "Casefile/1.0 (paper-trading research; public data)";
export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 400);
}

export async function fetchExhibit(
  request: Pick<Exhibit, "id" | "kind" | "source" | "url" | "method" | "requestBody">,
  normalize: (raw: string) => Exhibit["data"], options: EvidenceOptions = {}
): Promise<Exhibit> {
  let raw = "";
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await (options.fetchFn ?? fetch)(request.url, {
        method: request.method,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json, application/rss+xml, application/xml;q=0.9, */*;q=0.8",
          ...(request.method === "POST" ? { "Content-Type": "application/json" } : {}) },
        ...(request.requestBody === undefined ? {} : { body: JSON.stringify(request.requestBody) }),
        signal: AbortSignal.timeout(15_000)
      });
      raw = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = normalize(raw);
      return { ...request, fetchedAt: new Date(options.now ?? Date.now()).toISOString(),
        status: "ok", responseSha256: sha256(raw), data };
    } catch (cause) { error = errorMessage(cause); }
  }
  return { ...request, fetchedAt: new Date(options.now ?? Date.now()).toISOString(),
    status: "unavailable", error, responseSha256: sha256(raw), data: null };
}
