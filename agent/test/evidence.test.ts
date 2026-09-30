import { describe, expect, it, vi } from "vitest";
import { fetchExhibit, sha256 } from "../src/evidence/http.js";
import { normalizeCandles, fetchReviewCandles } from "../src/evidence/coinbase.js";
import { normalizeHyperliquid } from "../src/evidence/hyperliquid.js";
import { normalizeNews } from "../src/evidence/news.js";

describe("evidence normalization and transport", () => {
  it("sorts, deduplicates and truncates candles deterministically", () => {
    expect(normalizeCandles("[[7200,1,3,2,2,5],[0,1,3,2,2,5],[3600,1,3,2,2,5],[3600,1,3,2,2,5]]", 2))
      .toEqual([[3600, 1, 3, 2, 2, 5], [7200, 1, 3, 2, 2, 5]]);
    expect(() => normalizeCandles("[[0,2,1,1,1,1]]")).toThrow();
  });
  it("keeps only the requested Hyperliquid asset with fixed decimal strings", () => {
    const ctx = { funding: "0.00001", openInterest: "3", markPx: "10", oraclePx: "9", premium: "0.1", dayNtlVlm: "2" };
    expect(normalizeHyperliquid(JSON.stringify([{ universe: [{ name: "ETH" }, { name: "BTC" }] }, [ctx, { ...ctx, markPx: "12" }]]), "BTC").markPx).toBe("12.000000000000");
  });
  it("filters RSS with case-insensitive asset word boundaries and a 48-hour window", () => {
    const now = Date.parse("2026-09-30T00:00:00Z");
    const item = (title: string, date: string) => `<item><title>${title}</title><link>https://example.com/${title.replace(/ /g, "-")}</link><pubDate>${date}</pubDate></item>`;
    const xml = `<rss><channel>${item("BITCOIN rally", "Tue, 29 Sep 2026 12:00:00 GMT")}${item("btcoin rally", "Tue, 29 Sep 2026 12:00:00 GMT")}${item("btc rally", "Sat, 26 Sep 2026 12:00:00 GMT")}${item("BTC future", "Thu, 01 Oct 2026 12:00:00 GMT")}</channel></rss>`;
    expect(normalizeNews(xml, "BTC", "test", now).map(item => item.title)).toEqual(["BITCOIN rally"]);
    expect(() => normalizeNews("<html/>", "BTC", "test", now)).toThrow("RSS channel missing");
  });
  it("retries once, hashes original response bytes and supplies timeout and User-Agent", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("[[0,1,3,2,2,5]]"));
    const e = await fetchExhibit({ id: "E1", kind: "candles_1h", source: "test", method: "GET", url: "https://example.com" }, normalizeCandles, { fetchFn, now: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(2); expect(e.status).toBe("ok");
    expect(e.responseSha256).toBe(sha256("[[0,1,3,2,2,5]]"));
    expect(fetchFn.mock.calls[0]![1]?.headers).toHaveProperty("User-Agent");
    expect(fetchFn.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it("records failed sources as unavailable without aborting", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error("blocked"));
    const e = await fetchExhibit({ id: "E1", kind: "candles_1h", source: "test", method: "GET", url: "https://example.com" }, normalizeCandles, { fetchFn, now: 0 });
    expect(e).toMatchObject({ status: "unavailable", data: null, error: "blocked", responseSha256: sha256("") });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("paginates review candles below Coinbase's 300-candle limit", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => new Response("[[0,1,3,2,2,5]]"));
    const exhibits = await fetchReviewCandles("BTC", 0, 600 * 3600, { fetchFn, now: 0 });
    expect(exhibits).toHaveLength(3); expect(exhibits.map(e => e.id)).toEqual(["E1", "E2", "E3"]);
    for (const [url] of fetchFn.mock.calls) {
      const parsed = new URL(String(url));
      expect(Date.parse(parsed.searchParams.get("end")!) - Date.parse(parsed.searchParams.get("start")!)).toBeLessThanOrEqual(299 * 3600_000);
    }
  });
});
