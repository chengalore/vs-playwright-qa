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

test.setTimeout(90000);

const __dirname = dirname(fileURLToPath(import.meta.url));
const URLS_FILE = join(__dirname, "../data/monitor-urls.json");
const CHUNKS_FILE = join(__dirname, "../data/monitor-chunks.json");

const chunkIndex =
  process.env.CHUNK_INDEX !== undefined && process.env.CHUNK_INDEX !== ""
    ? Number(process.env.CHUNK_INDEX)
    : null;

let stores;
if (chunkIndex !== null && existsSync(CHUNKS_FILE)) {
  const chunks = JSON.parse(readFileSync(CHUNKS_FILE, "utf8"));
  stores = chunks[chunkIndex] ?? [];
  console.log(`Running chunk ${chunkIndex}: ${stores.length} stores`);
} else if (existsSync(URLS_FILE)) {
  stores = JSON.parse(readFileSync(URLS_FILE, "utf8"));
} else {
  stores = [];
}

if (stores.length === 0) {
  throw new Error(
    chunkIndex !== null
      ? `Chunk ${chunkIndex} is empty — check monitor-chunks.json`
      : "monitor-urls.json is empty — URL resolver step failed"
  );
}

const CDN_ERROR_PATTERNS = [
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_RESET",
  "ERR_NAME_NOT_RESOLVED",
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
        let navErr;
        for (let i = 0; i < 2; i++) {
          try {
            await page.goto(resolvedUrl, { timeout: 60000, waitUntil: "commit" });
            navErr = undefined;
            break;
          } catch (err) {
            navErr = err;
          }
        }
        if (navErr) throw navErr;
        // Stabilize page context; wait for full load so Snidel-style
        // window.addEventListener("load", init) patterns fire before we scroll.
        await page.waitForLoadState("domcontentloaded");
        await page.waitForLoadState("load");
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

      // Start PDC watcher immediately after navigation — many stores (Mash/Snidel)
      // only inject the widget after the product/check API resolves.
      const pdc = startPDCWatcher(page);

      // Trigger Virtusize UI — opens accordions and clicks VS button if present.
      // Must run after PDC watcher is set up so button-click-triggered requests are captured.
      await triggerVirtusizeUI(page);

      // Scroll to trigger lazy-mounted widgets
      await page.evaluate(() => {
        const container =
          document.querySelector("#vs-inpage") ||
          document.querySelector("#vs-inpage-mini") ||
          document.querySelector("#vs-inpage-luxury") ||
          document.querySelector("#vs-legacy-inpage") ||
          document.querySelector("#vs-kid") ||
          document.querySelector("#vs-smart-table") ||
          document.querySelector("#vs-placeholder-cart") ||
          document.querySelector(".block-right") ||
          document.querySelector(".block-detail");

        if (container) {
          container.scrollIntoView({ block: "center", behavior: "instant" });
        } else {
          const height =
            document?.body?.scrollHeight ||
            document?.documentElement?.scrollHeight ||
            2000;
          window.scrollTo(0, height);
        }
      });
      await page.waitForTimeout(2000);

      // Extra scroll — some stores (Snidel-style) don't inject until scrolled twice
      await page.evaluate(() => {
        const height =
          document?.body?.scrollHeight ||
          document?.documentElement?.scrollHeight ||
          2000;
        window.scrollTo(0, height);
      });
      await page.waitForTimeout(1000);

      if (phase === "widget" || phase === "events") {
        // Wait for PDC API to resolve before checking widget presence
        const pdcStart = Date.now();
        while (Date.now() - pdcStart < 40000) {
          if (pdc.validProduct !== undefined) break;
          await page.waitForTimeout(200);
        }

        if (pdc.validProduct !== true) {
          logMonitorResult({
            storeAlias,
            storeId,
            url: resolvedUrl,
            phase,
            status: "skipped",
            reason: "invalid_product",
            browser: testInfo.project.name,
            durationMs: Date.now() - startTime,
          });
          return;
        }

        // Scroll again now that PDC has resolved — widget may now be ready to mount
        await page.evaluate(() => {
          const container =
            document.querySelector("#vs-inpage") ||
            document.querySelector("#vs-inpage-mini") ||
            document.querySelector("#vs-inpage-luxury") ||
            document.querySelector("#vs-legacy-inpage") ||
            document.querySelector("#vs-kid") ||
            document.querySelector("#vs-smart-table") ||
            document.querySelector("#vs-placeholder-cart") ||
            document.querySelector(".block-right") ||
            document.querySelector(".block-detail");

          if (container) {
            container.scrollIntoView({ block: "center", behavior: "instant" });
          } else {
            const height =
              document?.body?.scrollHeight ||
              document?.documentElement?.scrollHeight ||
              2000;
            window.scrollTo(0, height);
          }
        });

        // Detect any Virtusize integration:
        //   - Shadow root on a VS container = fully initialized widget
        //   - #vs-placeholder-cart = widget slot mounted (shadow root comes later)
        //   - #virtusize-button = custom entry button integration (e.g. By Malene Birger)
        await page.waitForFunction(
          () => {
            // Container widgets — confirmed initialized when shadow root exists
            const containerSelectors = [
              "#vs-inpage",
              "#vs-inpage-mini",
              "#vs-inpage-luxury",
              "#vs-legacy-inpage",
              "#vs-kid",
              "#vs-smart-table",
            ];
            const hasWidget = containerSelectors.some((sel) => {
              const el = document.querySelector(sel);
              return el && el.shadowRoot;
            });

            // Placeholder slot — widget not yet initialized but VS script ran
            const hasPlaceholder = !!(
              document.querySelector("#vs-placeholder-cart") ||
              document.querySelector(".vs-placeholder-inpage") ||
              document.querySelector("#inpage-placeholder-wrapper")
            );

            // Custom entry button integration
            const hasEntryButton = !!document.querySelector("#virtusize-button");

            return hasWidget || hasPlaceholder || hasEntryButton;
          },
          { timeout: 30000 },
        );
      }

      if (phase === "api") {
        // Check PDC API fires and returns a valid product
        // pdc watcher was started after navigation above — reuse it here
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

async function triggerVirtusizeUI(page) {
  await page.evaluate(() => {
    // Open size/fit guide accordions (e.g. Camilla & Marc)
    document.querySelectorAll("summary").forEach((el) => {
      const text = el.textContent?.toLowerCase() || "";
      if (text.includes("size") || text.includes("fit") || text.includes("サイズ")) {
        const details = el.closest("details");
        if (details && !details.open) details.open = true;
      }
    });

    // Click Virtusize button if present (button-trigger stores)
    const vsButton = document.querySelector("#virtusize-button");
    if (vsButton) {
      vsButton.scrollIntoView({ block: "center" });
      vsButton.click();
    }
  });

  await page.waitForTimeout(1000);
}
