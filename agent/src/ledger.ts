import { createPublicClient, createWalletClient, defineChain, http, isAddress, parseAbi, parseEventLogs, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import type { CloseReason, LedgerCase, Ruling } from "./types.js";
import { ROOT, readJson } from "./paths.js";
import { z } from "zod";

export const ledgerAbi = parseAbi([
  "function openCase(bytes32 bundleHash, bytes32 asset, uint8 side, uint16 sizeBps, uint64 entryE8, uint64 stopE8, uint64 targetE8, uint32 horizon) returns (uint256 id)",
  "function closeCase(uint256 id, uint64 exitE8, uint8 reason, bytes32 reviewHash)",
  "function getCase(uint256 id) view returns ((address agent, bytes32 bundleHash, bytes32 asset, uint8 side, uint16 sizeBps, uint64 entryE8, uint64 stopE8, uint64 targetE8, uint64 openedAt, uint32 horizon, uint64 closedAt, uint64 exitE8, int32 pnlBps, uint8 reason, bytes32 reviewHash) c)",
  "function casesOf(address agent, uint256 offset, uint256 limit) view returns (uint256[])",
  "function caseCount() view returns (uint256)",
  "function isSealed(bytes32 bundleHash) view returns (bool)",
  "function stats(address agent) view returns (uint32 cases, uint32 open, uint32 closed, uint32 wins, uint32 losses, int64 sizedPnlBps)",
  "event CaseOpened(uint256 indexed id, address indexed agent, bytes32 indexed bundleHash, bytes32 asset, uint8 side, uint16 sizeBps, uint64 entryE8, uint64 stopE8, uint64 targetE8, uint32 horizon)",
  "event CaseClosed(uint256 indexed id, address indexed agent, uint64 exitE8, int32 pnlBps, uint8 reason, bytes32 reviewHash)"
]);
export const sideNumber = { Flat: 0, Long: 1, Short: 2 } as const;
export const reasonNumber = { Horizon: 1, Stop: 2, Target: 3 } as const;
export const paddedGas = (estimate: bigint) => (estimate * 130n + 99n) / 100n;
export const assetBytes = (asset: string) => stringToHex(asset, { size: 32 });

export function agentAccount() {
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("AGENT_PRIVATE_KEY must be a 32-byte hex private key");
  return privateKeyToAccount(key as `0x${string}`);
}

export function agentAddress(dryRun = false): `0x${string}` {
  const account = agentAccount();
  if (account) return account.address;
  const value = process.env.AGENT_ADDRESS;
  if (value) {
    if (!isAddress(value)) throw new Error("Invalid AGENT_ADDRESS");
    return value;
  }
  if (dryRun) return "0x0000000000000000000000000000000000000000";
  throw new Error("Set AGENT_PRIVATE_KEY, or AGENT_ADDRESS for read-only review");
}

export async function connectLedger(config: Config, write = false) {
  const chainId = Number(process.env.CHAIN_ID ?? config.chain.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("Invalid CHAIN_ID");
  const rpc = process.env.RPC_URL ?? config.chain.rpc;
  const addressValue = process.env.LEDGER_ADDRESS ?? z.object({ address: z.string() }).parse(await readJson(resolve(ROOT, "deployments", `${chainId}.json`))).address;
  if (!isAddress(addressValue) || /^0x0{40}$/i.test(addressValue)) throw new Error("Invalid LEDGER_ADDRESS");
  const address = addressValue as `0x${string}`;
  const chain = defineChain({ id: chainId, name: "Casefile paper ledger", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const transport = http(rpc, { retryCount: 5, retryDelay: 300, timeout: 15_000 });
  const publicClient = createPublicClient({ chain, transport });
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== chainId) throw new Error(`RPC chain ${actualChainId} does not match configured chain ${chainId}`);
  const account = write ? agentAccount() : undefined;
  if (write && !account) throw new Error("Live writes require AGENT_PRIVATE_KEY");
  const wallet = account ? createWalletClient({ account, chain, transport }) : undefined;
  return {
    async getCase(id: bigint): Promise<LedgerCase> { return publicClient.readContract({ address, abi: ledgerAbi, functionName: "getCase", args: [id] }); },
    async casesOf(agent: `0x${string}`): Promise<bigint[]> {
      const ids: bigint[] = [];
      for (let offset = 0n; ; offset += 100n) {
        const page = await publicClient.readContract({ address, abi: ledgerAbi, functionName: "casesOf", args: [agent, offset, 100n] });
        ids.push(...page);
        if (page.length < 100) return ids;
      }
    },
    async now(): Promise<number> { return Number((await publicClient.getBlock()).timestamp); },
    async open(bundleHash: `0x${string}`, asset: string, ruling: Ruling) {
      if (!wallet || !account) throw new Error("Ledger is read-only");
      const args = [bundleHash, assetBytes(asset), sideNumber[ruling.side], ruling.sizeBps,
        BigInt(ruling.entryE8), BigInt(ruling.stopE8), BigInt(ruling.targetE8), ruling.horizonSec] as const;
      const estimate = await publicClient.estimateContractGas({ address, abi: ledgerAbi, functionName: "openCase", args, account });
      const tx = await wallet.writeContract({ address, abi: ledgerAbi, functionName: "openCase", args, gas: paddedGas(estimate) });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`openCase transaction reverted: ${tx}`);
      const event = parseEventLogs({ abi: ledgerAbi, eventName: "CaseOpened", logs: receipt.logs })
        .find(log => log.address.toLowerCase() === address.toLowerCase() && log.args.bundleHash === bundleHash && log.args.agent.toLowerCase() === account.address.toLowerCase());
      if (!event) throw new Error(`Missing CaseOpened receipt event: ${tx}`);
      const opened = await this.getCase(event.args.id);
      return { id: event.args.id.toString(), tx, openedAt: Number(opened.openedAt) };
    },
    async close(id: bigint, exit: bigint, reason: CloseReason, reviewHash: `0x${string}`) {
      if (!wallet || !account) throw new Error("Ledger is read-only");
      const args = [id, exit, reasonNumber[reason], reviewHash] as const;
      const estimate = await publicClient.estimateContractGas({ address, abi: ledgerAbi, functionName: "closeCase", args, account });
      const tx = await wallet.writeContract({ address, abi: ledgerAbi, functionName: "closeCase", args, gas: paddedGas(estimate) });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`closeCase transaction reverted: ${tx}`);
      return tx;
    }
  };
}
