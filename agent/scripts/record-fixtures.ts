import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { fetchEvidence } from "../src/evidence/index.js";
import { AGENT_DIR, writeJson } from "../src/paths.js";
import { cli } from "../src/cli.js";

await cli(async () => {
  const { config } = await loadConfig();
  const recordedAt = new Date().toISOString();
  for (const asset of config.assets) {
    const exhibits = await fetchEvidence(asset, { now: Date.parse(recordedAt) });
    await writeJson(resolve(AGENT_DIR, "test", "fixtures", `${asset}.json`), { asset, recordedAt, exhibits });
    for (const e of exhibits) console.log(`${asset} ${e.id} ${e.source} ${e.kind}: ${e.status}${e.error ? ` (${e.error})` : ""}`);
  }
  console.log(`Recorded BTC, ETH, SOL fixtures at ${recordedAt}; unavailable sources are preserved, not synthesized.`);
});
