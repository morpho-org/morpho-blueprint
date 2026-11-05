#!/usr/bin/env node
// Full-page screenshots of the app on desktop and mobile, with console errors and failed requests.
// See "Parity and screenshot checks" in the README.
//
//   node scripts/verify/screenshots.mjs --url <base url> --name <local|prod> --out <dir>
//     [--paths /earn,/earn/1/0x...] [--playwright-from <dir with @playwright/test installed>]
//
// Exit 0: every page loaded. Exit 1: a page failed to load (navigation error or HTTP >= 400).
// Exit 2: bad input or Playwright not found.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    name: { type: "string", default: "local" },
    out: { type: "string", default: "screenshots" },
    paths: { type: "string", default: "/earn,/earn/1/0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB" },
    "playwright-from": { type: "string", default: process.cwd() },
  },
});

if (!values.url) {
  console.error("Usage: node scripts/verify/screenshots.mjs --url <base url> --name <label> --out <dir>");
  process.exit(2);
}

// Playwright stays out of package.json: it is resolved from wherever the reviewer installed it.
let chromium;
try {
  const require = createRequire(path.join(path.resolve(values["playwright-from"]), "noop.js"));
  ({ chromium } = require("@playwright/test"));
} catch {
  console.error(
    `@playwright/test not found from ${values["playwright-from"]}. Install it outside the repo, e.g.\n` +
      "  npm i --prefix /tmp/pw @playwright/test && npx --prefix /tmp/pw playwright install chromium\n" +
      "then pass --playwright-from /tmp/pw",
  );
  process.exit(2);
}

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

// Third-party overlays that cover the page and differ between deployments.
const BLOCKED = [/vercel\.live/, /\/_next-live\//, /intercom\.io/, /intercomcdn\.com/, /intercomassets\.com/];

const out = path.resolve(values.out);
mkdirSync(out, { recursive: true });
const pages = values.paths
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const slug = (p) => p.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-") || "root";

const browser = await chromium.launch();
const report = { url: values.url, name: values.name, takenAt: new Date().toISOString(), pages: [] };
let failedLoads = 0;

for (const [viewportName, options] of Object.entries(VIEWPORTS)) {
  const context = await browser.newContext(options);
  await context.route(
    (url) => BLOCKED.some((pattern) => pattern.test(url.href)),
    (route) => route.abort(),
  );

  for (const pagePath of pages) {
    const page = await context.newPage();
    const consoleErrors = [];
    const failedRequests = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
    page.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText ?? "failed";
      // Requests this script blocked on purpose are not the app's failures, nor requests the page
      // itself cancelled (Next aborts superseded RSC fetches).
      if (reason !== "net::ERR_ABORTED" && !BLOCKED.some((pattern) => pattern.test(request.url()))) {
        failedRequests.push({ url: request.url(), status: null, reason });
      }
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        failedRequests.push({ url: response.url(), status: response.status(), reason: response.statusText() });
      }
    });

    const target = new URL(pagePath, values.url).toString();
    const file = `${values.name}-${viewportName}-${slug(pagePath)}.png`;
    const entry = { path: pagePath, viewport: viewportName, file, status: null, error: null };
    try {
      const response = await page.goto(target, { waitUntil: "networkidle", timeout: 60_000 });
      entry.status = response?.status() ?? null;
      if (entry.status !== null && entry.status >= 400) failedLoads += 1;
      // Lets suspense boundaries and number animations settle before the capture.
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: path.join(out, file), fullPage: true });
    } catch (error) {
      entry.error = String(error);
      failedLoads += 1;
    }
    report.pages.push({ ...entry, consoleErrors, failedRequests });
    console.log(
      `${viewportName} ${pagePath}: ${entry.error ? `error ${entry.error}` : `HTTP ${entry.status}`}, ` +
        `${consoleErrors.length} console errors, ${failedRequests.length} failed requests`,
    );
    await page.close();
  }
  await context.close();
}
await browser.close();

writeFileSync(path.join(out, `${values.name}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${out}/${values.name}-report.json`);
process.exit(failedLoads > 0 ? 1 : 0);
