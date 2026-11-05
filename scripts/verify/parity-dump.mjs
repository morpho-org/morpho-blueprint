#!/usr/bin/env node
// Dumps a checkout's data providers to JSON. See "Parity and screenshot checks" in the README.
//
//   node scripts/verify/parity-dump.mjs --app <checkout> --out <file.json>
//     [--providers summaries,vaults] [--vaults 1:0xabc,1:0xdef] [--account 0x...] [--max-requests 50]
//
// Providers: summaries, vaults (default), market-summaries, vault-positions, market-positions (need --account).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

const { values } = parseArgs({
  options: {
    app: { type: "string", default: repo },
    out: { type: "string" },
    providers: { type: "string", default: "summaries,vaults" },
    vaults: { type: "string", default: "" },
    account: { type: "string", default: "" },
    "max-requests": { type: "string", default: "50" },
  },
});

if (!values.out) {
  console.error("Usage: node scripts/verify/parity-dump.mjs --app <checkout> --out <file.json>");
  process.exit(2);
}

const app = path.resolve(values.app);
if (!existsSync(path.join(app, "src/config/index.ts"))) {
  console.error(`${app} is not an app checkout (no src/config/index.ts)`);
  process.exit(2);
}
if (!existsSync(path.join(app, "node_modules"))) {
  console.error(`${app} has no node_modules; run pnpm install there first`);
  process.exit(2);
}

// A plain export of the tree (git archive) has no history: pass PARITY_GIT_SHA to label the dump.
const revParse = spawnSync("git", ["-C", app, "rev-parse", "HEAD"], { encoding: "utf8" });
const gitSha = process.env.PARITY_GIT_SHA || (revParse.status === 0 ? revParse.stdout.trim() : null);

const out = path.resolve(values.out);
mkdirSync(path.dirname(out), { recursive: true });

const result = spawnSync(
  process.execPath,
  [path.join(repo, "node_modules/vitest/vitest.mjs"), "run", "--config", path.join(here, "vitest.config.mts")],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PARITY_APP: app,
      PARITY_OUT: out,
      PARITY_PROVIDERS: values.providers,
      PARITY_VAULTS: values.vaults,
      PARITY_ACCOUNT: values.account,
      PARITY_MAX_REQUESTS: values["max-requests"],
      PARITY_GIT_SHA: gitSha ?? "",
    },
  },
);
process.exit(result.status ?? 1);
