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

test.setTimeout(60000);

const __dirname = dirname(fileURLToPath(import.meta.url));
const URLS_FILE = join(__dirname, "../data/monitor-urls.json");

const stores = existsSync(URLS_FILE)
  ? JSON.parse(readFileSync(URLS_FILE, "utf8"))
  : [];

const phase = process.env.TEST_PHASE || "widget";

for (const { storeAlias, storeId, url, fromFallback } of stores) {
  if (!url) {
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
      await page.goto(url, { timeout: 30000, waitUntil: "domcontentloaded" });

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
        url,
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
        url,
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
