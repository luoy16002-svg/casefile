export type Asset = "BTC" | "ETH" | "SOL";
export type Side = "Flat" | "Long" | "Short";
export type CloseReason = "Horizon" | "Stop" | "Target";
export type Candle = [number, number, number, number, number, number];
export interface HyperData {
  funding: string; openInterest: string; markPx: string;
  oraclePx: string; premium: string; dayNtlVlm: string;
}
export interface FngItem { timestamp: number; value: number }
export interface NewsItem { title: string; link: string; pubDate: string; source: string }
export interface Exhibit {
  id: string;
  kind: "candles_1h" | "candles_1d" | "hyperliquid" | "fear_greed" | "news";
  source: string; url: string; method: "GET" | "POST"; requestBody?: unknown;
  fetchedAt: string; status: "ok" | "unavailable"; error?: string;
  responseSha256: string;
  data: Candle[] | HyperData | FngItem[] | NewsItem[] | null;
}
export interface Signal {
  name: string; value: number | null; unit: string; exhibits: string[]; note: string;
}
export interface Claim { text: string; cites: string[]; signal: string | null }
export interface StruckClaim { claim: Claim; reason: string }
export interface Brief {
  mode: "llm" | "template"; model: string; prompt: string;
  rawResponse: string; claims: Claim[]; struck: StruckClaim[]; strength: number; error?: string;
}
export interface Debate { bull: Brief; bear: Brief }
export interface Contribution {
  rule: string; vote: number; weight: number; inputs: string[]; reason: string;
}
export interface Ruling {
  side: Side; sizeBps: number; entryE8: string; stopE8: string; targetE8: string;
  horizonSec: number; score: number; contributions: Contribution[]; summary: string;
}
export interface Bundle {
  schema: "casefile/1"; agent: `0x${string}`; asset: Asset; createdAt: string;
  judgeVersion: string; configHash: `0x${string}`; codeRef: string;
  exhibits: Exhibit[]; signals: Signal[]; debate: Debate; ruling: Ruling;
}
export interface ReviewBundle {
  schema: "casefile-review/1"; caseId: string; bundleHash: `0x${string}`;
  reason: CloseReason; exitE8: string; exhibits: Exhibit[];
}
export interface LedgerCase {
  agent: `0x${string}`; bundleHash: `0x${string}`; asset: `0x${string}`;
  side: number; sizeBps: number; entryE8: bigint; stopE8: bigint; targetE8: bigint;
  openedAt: bigint; horizon: number; closedAt: bigint; exitE8: bigint;
  pnlBps: number; reason: number; reviewHash: `0x${string}`;
}
