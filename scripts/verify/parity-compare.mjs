#!/usr/bin/env node
// Compares two parity dumps. See "Parity and screenshot checks" in the README.
//
//   node scripts/verify/parity-compare.mjs <base.json> <head.json>
//     [--accepted scripts/verify/accepted-differences.json] [--report <file.md>]
//
// Exit 0: no unexpected difference. Exit 1: at least one. Exit 2: bad input.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AMOUNT_TOLERANCE, classify, diffDumps, USD_TOLERANCE } from "./parity-compare-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    accepted: { type: "string", default: path.join(here, "accepted-differences.json") },
    report: { type: "string" },
  },
});

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Cannot read ${file}: ${error.message}`);
    process.exit(2);
  }
}

if (positionals.length !== 2) {
  console.error("Usage: node scripts/verify/parity-compare.mjs <base.json> <head.json> [--report <file.md>]");
  process.exit(2);
}

const [baseFile, headFile] = positionals;
const base = readJson(baseFile);
const head = readJson(headFile);
for (const [file, dump] of [
  [baseFile, base],
  [headFile, head],
]) {
  if (!dump?.data || !dump?.meta) {
    console.error(`${file} is not a parity dump (no meta/data)`);
    process.exit(2);
  }
}
const acceptedList = readJson(values.accepted).accepted ?? [];

const { differences, trimmedPoints } = diffDumps(base.data, head.data);
const { accepted, unexpected, unused } = classify(differences, acceptedList);

const cell = (text, max = 120) => String(text).replace(/\|/g, "\\|").slice(0, max);
const lines = [
  `Parity: base ${base.meta.gitSha?.slice(0, 7) ?? "?"} (${base.meta.generatedAt}, ${base.meta.requests.total} requests)`,
  `vs head ${head.meta.gitSha?.slice(0, 7) ?? "?"} (${head.meta.generatedAt}, ${head.meta.requests.total} requests).`,
  `Tolerances: amounts and ratios ${AMOUNT_TOLERANCE}, USD ${USD_TOLERANCE * 100}% relative, everything else exact.`,
  "",
  `- Unexpected differences: ${unexpected.length}`,
  `- Accepted differences: ${accepted.length}`,
  `- Chart points outside the common window (not compared): ${trimmedPoints}`,
];
if (unexpected.length > 0) {
  lines.push("", "| kind | path | base | head |", "| --- | --- | --- | --- |");
  for (const d of unexpected) lines.push(`| ${d.kind} | ${cell(d.path, 240)} | ${cell(d.base)} | ${cell(d.head)} |`);
}
if (accepted.length > 0) {
  const byReason = new Map();
  for (const d of accepted)
    byReason.set(`${d.ticket ?? "-"}: ${d.reason}`, (byReason.get(`${d.ticket ?? "-"}: ${d.reason}`) ?? 0) + 1);
  lines.push("", "Accepted, by entry:");
  for (const [reason, count] of byReason) lines.push(`- ${count} x ${reason}`);
}
if (unused.length > 0) {
  lines.push("", "Accepted entries that matched nothing:");
  for (const entry of unused) lines.push(`- \`${entry.path}\` (${entry.ticket ?? "-"})`);
}

const text = `${lines.join("\n")}\n`;
process.stdout.write(text);
if (values.report) writeFileSync(values.report, text);
process.exit(unexpected.length > 0 ? 1 : 0);
