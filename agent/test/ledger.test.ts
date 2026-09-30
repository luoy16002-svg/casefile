import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from "viem";
import { connectLedger, ledgerAbi, paddedGas, assetBytes } from "../src/ledger.js";
import { config, ledgerCase, testAgent } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  rpc: { getChainId: vi.fn(), getBlock: vi.fn(), readContract: vi.fn(), estimateContractGas: vi.fn(), waitForTransactionReceipt: vi.fn() },
  wallet: { writeContract: vi.fn() }, transport: vi.fn()
}));
vi.mock("viem", async importOriginal => ({
  ...await importOriginal<typeof import("viem")>(),
  createPublicClient: () => mocks.rpc, createWalletClient: () => mocks.wallet, http: mocks.transport
}));
const address = "0x1111111111111111111111111111111111111111" as const;
const hash = `0x${"2".repeat(64)}` as const;
const tx = `0x${"3".repeat(64)}` as const;
// Public Anvil account #0; this key is only used by mocked, offline tests.
const testKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("LEDGER_ADDRESS", address); vi.stubEnv("CHAIN_ID", "31337"); vi.stubEnv("RPC_URL", "http://127.0.0.1:8545"); vi.stubEnv("AGENT_PRIVATE_KEY", testKey);
  mocks.rpc.getChainId.mockResolvedValue(31337);
  mocks.rpc.estimateContractGas.mockResolvedValue(101n);
  mocks.wallet.writeContract.mockResolvedValue(tx);
});
afterEach(() => vi.unstubAllEnvs());

describe("ledger transport", () => {
  it("pads estimates upward by 30% and configures retries", async () => {
    expect(paddedGas(101n)).toBe(132n);
    await connectLedger(config);
    expect(mocks.transport).toHaveBeenCalledWith("http://127.0.0.1:8545", { retryCount: 5, retryDelay: 300, timeout: 15_000 });
  });
  it("waits for a successful opening receipt and obtains the actual ID from the event", async () => {
    const topics = encodeEventTopics({ abi: ledgerAbi, eventName: "CaseOpened", args: { id: 7n, agent: testAgent, bundleHash: hash } });
    const data = encodeAbiParameters(parseAbiParameters("bytes32, uint8, uint16, uint64, uint64, uint64, uint32"), [assetBytes("BTC"), 0, 0, 100n, 0n, 0n, 3600]);
    mocks.rpc.waitForTransactionReceipt.mockResolvedValue({ status: "success", logs: [{ address, topics, data }] });
    mocks.rpc.readContract.mockResolvedValue(ledgerCase({ openedAt: 1234n }));
    const ledger = await connectLedger(config, true);
    const r = { side: "Flat" as const, sizeBps: 0, entryE8: "100", stopE8: "0", targetE8: "0", horizonSec: 3600, score: 0, contributions: [], summary: "Flat" };
    expect(await ledger.open(hash, "BTC", r)).toEqual({ id: "7", tx, openedAt: 1234 });
    expect(mocks.wallet.writeContract.mock.calls[0]![0].gas).toBe(132n);
    expect(mocks.rpc.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: tx, timeout: 120_000 });
  });
  it("rejects reverted opening and closing receipts", async () => {
    mocks.rpc.waitForTransactionReceipt.mockResolvedValue({ status: "reverted", logs: [] });
    const ledger = await connectLedger(config, true);
    await expect(ledger.open(hash, "BTC", { side: "Flat", sizeBps: 0, entryE8: "1", stopE8: "0", targetE8: "0", horizonSec: 3600, score: 0, contributions: [], summary: "Flat" })).rejects.toThrow("transaction reverted");
    await expect(ledger.close(1n, 100n, "Horizon", hash)).rejects.toThrow("transaction reverted");
  });
  it("closes with padded gas and blocks writes in read-only mode", async () => {
    mocks.rpc.waitForTransactionReceipt.mockResolvedValue({ status: "success", logs: [] });
    const ledger = await connectLedger(config, true);
    expect(await ledger.close(1n, 100n, "Target", hash)).toBe(tx);
    expect(mocks.wallet.writeContract.mock.calls[0]![0]).toMatchObject({ functionName: "closeCase", gas: 132n, args: [1n, 100n, 3, hash] });
    const readonly = await connectLedger(config);
    await expect(readonly.close(1n, 100n, "Horizon", hash)).rejects.toThrow("read-only");
  });
  it("rejects the wrong RPC chain and paginates oldest-first case IDs", async () => {
    mocks.rpc.getChainId.mockResolvedValueOnce(1);
    await expect(connectLedger(config)).rejects.toThrow("does not match");
    mocks.rpc.readContract.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => BigInt(i + 1))).mockResolvedValueOnce([101n]);
    const ledger = await connectLedger(config);
    const ids = await ledger.casesOf(testAgent);
    expect(ids).toHaveLength(101); expect(ids[0]).toBe(1n); expect(ids[100]).toBe(101n);
  });
});
