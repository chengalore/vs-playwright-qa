/**
 * Multi-store monitor test.
 *
 * Reads pre-resolved store URLs from data/monitor-urls.json (written by the
 * inpage-monitor.yml workflow before tests run) and runs one test per store
 * in parallel across Playwright workers.
 *
 * Supported TEST_PHASE values: widget | api
 * Default phase: widget
 *
 * Each test logs a MONITOR_RESULT JSON line consumed by the Slack summary step.
 */

import { test, expect } from "@playwright/test";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { startPDCWatcher } from "../utils/pdcWatcher.js";
import { loadFallback } from "../utils/fallbackStore.js";
import { BOT_PROTECTED_ALIASES, BOT_PROTECTED_REASON } from "../config/botProtectedStores.js";

test.setTimeout(60000);

const __dirname = dirname(fileURLToPath(import.meta.url));
const URLS_FILE = join(__dirname, "../data/monitor-urls.json");

const stores = existsSync(URLS_FILE)
  ? JSON.parse(readFileSync(URLS_FILE, "utf8"))
  : [];

if (stores.length === 0) {
  throw new Error("monitor-urls.json is empty — URL resolver step failed");
}

const CDN_ERROR_PATTERNS = [
  "ERR_HTTP2_PROTOCOL_ERROR",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_RESET",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_NETWORK_CHANGED",
  "net::ERR_",
  "Navigation timeout",
  "Timeout exceeded while waiting",
];

const phase = process.env.TEST_PHASE || "widget";

for (const { storeAlias, storeId, url, fromFallback } of stores) {
  if (BOT_PROTECTED_ALIASES.has(storeAlias)) {
    test(`[${storeAlias}] ${phase}`, async ({}, testInfo) => {
      logMonitorResult({
        storeAlias,
        storeId,
        url: url || null,
        phase,
        status: "bot_protected",
        reason: BOT_PROTECTED_REASON,
        browser: testInfo.project.name,
        durationMs: 0,
      });
    });
    continue;
  }

  // URL resolution priority: fallbackProducts.json → workflow-provided URL
  const resolvedUrl = loadFallback(storeAlias) || url || null;

  if (!resolvedUrl) {
    // Store had no resolvable URL — log as skipped
    test(`[${storeAlias}] ${phase}`, async ({}, testInfo) => {
      logMonitorResult({
        storeAlias,
        storeId,
        url: null,
        phase,
        status: "skipped",
        reason: "No product URL resolved",
        browser: testInfo.project.name,
        durationMs: 0,
      });
    });
    continue;
  }

  test(`[${storeAlias}] ${phase}`, async ({ page }, testInfo) => {
    const startTime = Date.now();

    try {
      try {
        await page.goto(resolvedUrl, { timeout: 30000, waitUntil: "domcontentloaded" });
      } catch (navError) {
        const msg = navError.message || "";
        const isCdnError = CDN_ERROR_PATTERNS.some((p) => msg.includes(p));
        logMonitorResult({
          storeAlias,
          storeId,
          url: resolvedUrl,
          phase,
          status: "skipped",
          reason: isCdnError ? "cdn_blocked" : "navigation_error",
          error: msg.split("\n")[0].slice(0, 200),
          browser: testInfo.project.name,
          durationMs: Date.now() - startTime,
        });
        return; // skip without failing
      }

      // Scroll to trigger lazy-mounted widgets
      await page.evaluate(() => window.scrollTo({ top: 800, behavior: "instant" }));
      await page.waitForTimeout(1500);

      if (phase === "widget" || phase === "events") {
        // Check widget element is present in DOM
        await page.waitForFunction(
          () =>
            document.querySelector("#vs-inpage") ||
            document.querySelector("#vs-legacy-inpage") ||
            document.querySelector("#vs-kid"),
          { timeout: 20000 },
        );
      }

      if (phase === "api") {
        // Check PDC API fires and returns a valid product
        const pdc = startPDCWatcher(page);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.evaluate(() => window.scrollTo({ top: 800, behavior: "instant" }));

        const start = Date.now();
        while (Date.now() - start < 15000) {
          if (pdc.validProduct !== undefined) break;
          await page.waitForTimeout(200);
        }

        if (pdc.validProduct !== true) {
          throw new Error(`PDC validProduct=${pdc.validProduct} (productType: ${pdc.productType})`);
        }
      }

      logMonitorResult({
        storeAlias,
        storeId,
        url: resolvedUrl,
        phase,
        status: "passed",
        fromFallback: fromFallback || false,
        browser: testInfo.project.name,
        durationMs: Date.now() - startTime,
      });
    } catch (error) {
      const isWidgetMissing =
        error.message.includes("waiting for function") ||
        error.message.includes("Timeout") ||
        error.message.toLowerCase().includes("widget");

      logMonitorResult({
        storeAlias,
        storeId,
        url: resolvedUrl,
        phase,
        status: isWidgetMissing ? "widget_missing" : "failed",
        error: error.message.split("\n")[0].slice(0, 200),
        fromFallback: fromFallback || false,
        browser: testInfo.project.name,
        durationMs: Date.now() - startTime,
      });

      throw error;
    }
  });
}

function logMonitorResult(result) {
  console.log("MONITOR_RESULT:", JSON.stringify(result));
}
