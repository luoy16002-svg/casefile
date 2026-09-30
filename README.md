# Casefile backend

Casefile records practice-trading decisions for BTC, ETH and SOL as canonical JSON bundles. A Solidity ledger seals each bundle hash and stores immutable opening fields, closure results and per-agent paper P&L. There is no real asset transfer or paper-equity accounting in the contract.

## Files and toolchain

`contracts/` is a Foundry project using Solidity 0.8.28 and the existing vendored `forge-std`. `agent/` uses Node 22, TypeScript ESM, viem, zod and fast-xml-parser. Tests use Vitest and require no network. `cases/`, `reviews/` and `deployments/` hold persistent output. No frontend is included.

From `contracts/`, run `forge build` and `forge test`. From `agent/`, run `npm ci`, `npm test` and `npx tsc --noEmit`. Package versions are locked in `agent/package-lock.json`.

## Configuration and commands

The canonical hash of `agent/casefile.config.json` goes into every case. Judge weights and thresholds are configurable. Canonical configs are archived in `agent/configs/<configHash>.json` when the agent opens a case. Replay and review select the config matching the opening bundle's hash, so older cases survive config changes. The current config is a fallback only when its hash matches; a missing or mismatched archive fails clearly. Replay still rejects an unsupported judge version. `GITHUB_SHA` supplies `codeRef`, otherwise it is `local`.

Run these from `agent/`:

```sh
npm run record-fixtures
npm run agent -- --dry-run --no-llm --assets BTC,ETH,SOL --out ./tmp
npm run replay -- ./tmp/<bundleHash>.json --offline
npm run agent -- --assets BTC,ETH
npm run review -- --dry-run
npm run review
npm run replay -- <caseId-or-bundleHash-or-path>
```

`record-fixtures` deliberately replaces the three fixture files with new public data. Fixed return/RSI assertions must then be independently reviewed and updated; see `agent/test/fixtures/EXPECTATIONS.md`. Running tests never refreshes fixtures, and a test setup rejects unmocked fetches.

Dry-run agent commands use `--out`, defaulting to `./tmp` relative to the working directory, and do not connect to a chain. Output paths must remain inside this project, including symlink resolution. Dry-run review reads the ledger and writes candidate review bundles to `agent/tmp/reviews/`. Live bundles go to root `cases/`, and live reviews to root `reviews/`. Existing hash-named bundles are never overwritten with different bytes.

Environment variables:

| Variable | Purpose |
|---|---|
| `AGENT_PRIVATE_KEY` | Account used by live open/close commands; test keys are appropriate for local tests. Never put an actual key in source or fixtures. |
| `AGENT_ADDRESS` | Optional identity for dry-run agent or read-only review when no key is provided. Otherwise agent dry-run uses the zero address. |
| `LEDGER_ADDRESS` | Ledger address; fallback is root `deployments/<chainId>.json` with an `address` field. |
| `RPC_URL`, `CHAIN_ID` | Optional connection overrides; defaults are chain 46630 and the Robinhood testnet RPC in config. They do not change the trading config hash. |
| `OLLAMA_URL` | Ollama native API base URL, default `http://127.0.0.1:11434`. No API key is needed. Like `RPC_URL`, it does not change the config hash. |
| `CASEFILE_BUNDLE_BASE` | Optional base URL for downloading `<bundleHash>.json` when it is absent locally. |
| `GITHUB_SHA` | Optional code revision string recorded in a bundle. |
| `PRIVATE_KEY` | Read only by the deployment script, separate from the agent key variable. |

An online replay needs the ledger address and RPC, but no private key. A case ID resolves through the ledger online or `cases/index.json` offline. A bundle hash or path resolves directly; online replay scans that bundle's agent IDs if necessary. Each index entry contains `id` (decimal string), `bundleHash`, `asset`, `side`, `tx`, and `openedAt` (Unix seconds). E8 prices and case IDs in JSON are decimal strings to preserve integers beyond JavaScript's exact numeric range. On-chain enums are Flat/Long/Short = 0/1/2 and None/Horizon/Stop/Target = 0/1/2/3.

## Evidence, signals and debate

Exhibit IDs have a fixed order: E1 hourly Coinbase candles (latest 72); E2 daily Coinbase candles (latest 60); E3 this asset's Hyperliquid context; E4 14 Fear & Greed observations; E5 CoinDesk RSS; E6 Cointelegraph RSS; E7 Decrypt RSS. Requests use a User-Agent, a 15-second timeout and one retry. An unavailable source is preserved with its error and null data. `responseSha256` hashes the original response text, before normalization, and uses lowercase hexadecimal without `0x`; a network failure with no response hashes the empty string.

Candles are sorted oldest first, deduplicated by timestamp, with price and volume numbers rounded to eight decimals. Hyperliquid's six retained decimals are strings with 12 decimal places. Fear & Greed values and timestamps are integers sorted oldest first. RSS titles use whole-word, case-insensitive asset matching, a 48-hour window at the recorded fetch time and deterministic date/title/link ordering. Each feed retains its own items; counts include matching items across feeds, without cross-feed deduplication.

All signal values are rounded to six decimals. Hourly returns require observations exactly one or 24 hours apart; seven-day return uses daily closes. Price versus SMA compares the latest hourly close with the latest 20 daily closes. RSI and ATR use Wilder smoothing over the retained hourly series; indicators requiring a continuous series become null when candles have gaps. RSI seeds 14 close changes, reports 50 for an unchanged series and 100 when there are only gains. ATR seeds the first 14 true ranges, including high minus low for the first candle. Realized volatility is the population standard deviation of the latest 24 hourly log returns multiplied by sqrt(24) and 100. Annualized funding assumes the API funding rate is hourly and multiplies by 24 × 365 × 100. Open interest USD is open interest times mark price. Fear & Greed change requires an observation exactly seven days earlier.

News tone uses the fixed positive/negative title-word lists in `signals.ts`: `(positiveMatches - negativeMatches) / totalMatches`, or zero without matches. Both news signals require all three feeds; a failed feed makes those signals null. Every signal records its exhibit dependencies and formula note.

Bull and bear receive the same signal/exhibit/title input, with distinct role instructions from `prompts/`. Their JSON output is validated before citation checks. A claim with no citations, unknown/unavailable citations or an unknown signal is struck with its reason. The bundle retains the full prompt, model ID, raw text, surviving claims and struck claims. The validator checks citation existence and availability, not whether prose is factually supported by the citation. A failed LLM call produces a deterministic template with the error recorded; malformed raw model text is retained.

With `debate.directionCheck: "v1"`, cited signals must favour the brief's side using the judge's configured thresholds; neutral, missing and non-directional signals are struck with reproducible reasons. Claims with `signal: null` remain subject to citation checks and surviving ones are counted as `unchecked`; a single explicit signal identifier in text that differs from the declared signal is also struck. Replay uses each bundle's archived config, so bundles without the direction-check setting retain their original validation.

GitHub Models was retired on 2026-07-30; its endpoint returned HTTP 200 with plain `OK`, causing the debates in cases 3–5 to fall back. Casefile now runs the local Ollama model `qwen2.5:7b` without an API key. The legacy `github-models` config value remains valid for old cases, but new attempts record `GitHub Models was retired on 2026-07-30` and use the template.

Ollama uses the [native chat API](https://docs.ollama.com/api/chat) with a per-case JSON schema restricting citations to available exhibits and signals to non-null names or `null`, recorded exactly as `responseFormat` in each model brief. Generation uses temperature 0, seed 42, `num_ctx: 8192` and `num_predict: 700`, with bull finishing before bear starts and a 600-second timeout per call. Parsing repairs missing signals to `null` and splits, trims and upper-cases joined citations, recording `normalized: true` when repaired; other validation stays strict and invalid claims retain their strike reasons.

Each model brief also records the exact `modelDigest` from [the installed model list](https://docs.ollama.com/api/tags), or `null` if lookup fails. Older bundles can omit `modelDigest`, `responseFormat` and `normalized`. Preserve the weights identified by that digest and compare it with the installed model's digest when reproducing an old debate; model tags can change.

To reproduce a debate locally, install Ollama using its [official setup instructions](https://docs.ollama.com/linux), then run:

```sh
# Terminal 1
ollama serve
# Terminal 2
ollama pull qwen2.5:7b
curl http://127.0.0.1:11434/api/tags
cd agent
OLLAMA_URL=http://127.0.0.1:11434 npm run agent -- --dry-run --assets BTC --out ./tmp
```

That command uses fresh evidence. For a stored debate, submit its exact stored bull and bear prompts to `/api/chat` with its archived model and temperature, seed 42, stored `responseFormat`, `num_ctx: 8192` and `num_predict: 700`. Phase 3 bundles used `format: "json"` without context or prediction limits; preserve those original settings when reproducing them. Calling `buildDebate` with a bundle's `exhibits`, `signals` and archived config instead uses the current prompts and generation settings. Matching weights and settings identifies the intended model run; output can vary across Ollama versions and hardware. Offline replay verifies the stored briefs and ruling without running inference. Phase 3 and Phase 4 validation used mocks only; Ollama was not installed and no model was downloaded on this machine.

## Judge and hashes

Judge version `1` records all seven rule votes, weights, inputs and reasons. Votes are rounded to six decimals before aggregation. A rule with missing inputs contributes a neutral vote and its weight is excluded from the score denominator. The debate vote is always available from the stored briefs and is capped at ±0.5. Zero realized volatility gives a neutral momentum vote. The rounded score is Long at or above 0.25, Short at or below -0.25, otherwise Flat.

The stop formula is:

```text
stopPct = round4(clamp(1.5 × atr14_1h_pct × sqrt(horizonHours), minStopPct, maxStopPct))
targetPct = stopPct × rewardRisk
sizeBps = max(1, round(maxSizeBps × min(1, abs(score)) × min(1, 3 / stopPct)))
```

Stop and target percentages are applied to the latest hourly close using integer E8 arithmetic, with nearest-integer rounding and half ties upward. Flat uses size, stop and target zero. Missing ATR forces Flat. If hourly price evidence is unavailable, the bundle is saved with Flat and entry zero for inspection; a live run reports that asset as failed because the contract requires a positive entry. It continues processing other assets and exits nonzero after reporting failures.

Canonical JSON recursively sorts object keys, preserves array order and uses JSON.stringify number formatting with no extra whitespace or newline. Undefined, nonfinite numbers, bigints and non-plain objects are rejected. Bundle and review hashes are keccak256 of those UTF-8 bytes. Replay requires the exact canonical bytes, checks a hash-named file against its filename, checks config and citations, then recomputes all signals and the complete ruling, including reasons and summary. Online replay additionally checks the agent, asset and every on-chain ruling field. Offline replay of an arbitrarily renamed file with no supplied hash cannot authenticate metadata against a chain seal; hash-named files provide the expected digest.

## Ledger, review and workflows

`CaseLedger` has no owner, administrator or upgrade path. Any address may open its own cases, including Flat cases. Hashes can be sealed only once across the ledger. Case IDs start at 1. Only the originating agent may close its case. Opening fields never change. Unsized P&L is signed `(exit - entry) * 10000 / entry` with the short sign inverted, rounded toward zero. Sized aggregate P&L applies size bps after unsized rounding. Flat and break-even cases count as neither win nor loss. Overflow beyond the contract's declared P&L/stat/timestamp ranges has custom errors.

Review reads all of the agent's cases and processes open ones using Coinbase hourly history, paginated in windows of at most 299 hours. It walks candles chronologically, uses the first stop/target crossing, and takes the stop if both occur in one candle. A candle beginning before entry is skipped for stop/target detection, because its range includes pre-entry prices; its latest close remains usable for Horizon. Missing chunks or candle gaps leave the case open with a reported error. Otherwise Horizon uses the latest observed close once chain time reaches the deadline. Price requests use actual market time, so a local chain time warp does not ask Coinbase for future data. Review checks price crossings before the Horizon fallback even if the reviewer runs late, as specified in the brief. Hourly ranges cannot establish intrahour execution order, and live API candles can still be forming. Paper fills use the exact trigger level without slippage.

Ledger transport retries RPC requests five times, verifies the RPC chain ID, uses ceiling(estimate × 1.3) gas, waits for receipts and rejects reverted transactions. Immutable JSON is saved before submission so receipt failures do not erase evidence. Transactions and index updates are separate operations; if a transaction succeeds but the subsequent index write fails, the JSON and chain record still exist and online replay by hash remains possible. Cross-process file locking is not implemented; the scheduled workflow serializes runs with a shared concurrency group.

CI builds/tests the vendored Foundry project and runs npm ci, offline Vitest and strict TypeScript under Node 22. The scheduled workflow runs at `17 */6 * * *` or manually, installs Ollama, caches `~/.ollama/models` by model tag, starts the server, waits up to 60 seconds for readiness and pulls `qwen2.5:7b`. It reviews first, then opens new cases, and commits case/review files and config archives with a UTC timestamp. Configure the repository's `AGENT_PRIVATE_KEY` secret and `LEDGER_ADDRESS` variable before enabling it. The workflow's commit commands are stored as source only; they were not executed during this implementation.

`contracts/script/Deploy.s.sol` reads `PRIVATE_KEY`, creates the ledger and writes `deployments/<chainId>.json`. Run Foundry scripts from `contracts/` so the deployment path is correct. Phase 2 completed the local Anvil deployment, opening, Horizon review and online replay checks; see `PHASE2-REPORT.md`.

## Live deployment

CaseLedger was deployed on 2026-09-30 to Robinhood Chain Testnet, chain ID 46630. The ledger is [0x2472d3bDa25e4b3B22C32c25E43e2D0Aa2473008](https://explorer.testnet.chain.robinhood.com/address/0x2472d3bDa25e4b3B22C32c25E43e2D0Aa2473008).

The first BTC case is case 1, transaction [0xfca90330ee976972ef99e21a39c68a1f346724c85c6ae0323ea92cdd30922087](https://explorer.testnet.chain.robinhood.com/tx/0xfca90330ee976972ef99e21a39c68a1f346724c85c6ae0323ea92cdd30922087). The first ETH case is case 2, transaction [0x426e6f5319a3e81a0bb8351e7af454be4556e27f066ba25d7a97105b51f68b56](https://explorer.testnet.chain.robinhood.com/tx/0x426e6f5319a3e81a0bb8351e7af454be4556e27f066ba25d7a97105b51f68b56). Both rulings are Flat, were generated with `--no-llm`, and passed online replay. Review found zero due cases.
