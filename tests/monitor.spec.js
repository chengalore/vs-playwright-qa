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
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { startPDCWatcher } from "../utils/pdcWatcher.js";
import { loadFallback } from "../utils/fallbackStore.js";
import { BOT_PROTECTED_ALIASES, BOT_PROTECTED_REASON } from "../config/botProtectedStores.js";
import { MONITOR_STORES } from "../config/monitorStores.js";
import { blockMarketingScripts } from "../utils/blockMarketingScripts.js";

test.setTimeout(90000);

const __dirname = dirname(fileURLToPath(import.meta.url));
const URLS_FILE = join(__dirname, "../data/monitor-urls.json");
const CHUNKS_FILE = join(__dirname, "../data/monitor-chunks.json");
const FALLBACK_FILE = join(__dirname, "../data/fallbackProducts.json");

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
  // Local fallback — build store list from fallbackProducts.json + monitorStores config
  const fallbacks = existsSync(FALLBACK_FILE)
    ? JSON.parse(readFileSync(FALLBACK_FILE, "utf8"))
    : {};
  stores = Object.entries(MONITOR_STORES).map(([alias, storeId]) => ({
    storeAlias: alias,
    storeId,
    url: fallbacks[alias] ?? null,
    fromFallback: !!fallbacks[alias],
  }));
  console.log(`Local run: built ${stores.length} stores from fallbackProducts.json`);
}

if (stores.length === 0) {
  throw new Error(
    chunkIndex !== null
      ? `Chunk ${chunkIndex} is empty — check monitor-chunks.json`
      : "No stores found — add entries to data/fallbackProducts.json"
  );
}

const CDN_ERROR_PATTERNS = [
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_RESET",
  "ERR_NAME_NOT_RESOLVED",
];

const phase = process.env.TEST_PHASE || "widget";
const RESULTS_DIR = join(__dirname, "../data/monitor-results");

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
    let widgetVisibleMs = null;

    // Hide headless indicators and continuously dismiss third-party overlays
    // (Buyee, WorldShopping, KARTE) that can cover the page and prevent the
    // VS widget's IntersectionObserver from firing.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      document.hasFocus = () => true;

      let lastDismiss = 0;
      const dismissOverlays = () => {
        const now = Date.now();
        if (now - lastDismiss < 300) return;
        lastDismiss = now;
        document.querySelectorAll("#buyee-bcFrame, #buyee-bcSection, .bcModalBase").forEach((el) => el.remove());
        document.querySelectorAll(".bcIntro__closeBtn").forEach((el) => el.click());
        const wsShadow = document.querySelector("#zigzag-worldshopping-checkout")?.shadowRoot;
        if (wsShadow) {
          wsShadow.querySelector("#zigzag-test__banner-close-popup")?.click();
          wsShadow.querySelector("#zigzag-test__banner-hide")?.click();
          const wsInner = wsShadow.querySelector("#zigzag-worldshopping-checkout");
          if (wsInner) wsInner.style.display = "none";
        }
        document.querySelectorAll(".karte-close").forEach((el) => el.click());
      };
      const observer = new MutationObserver(dismissOverlays);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });

    await blockMarketingScripts(page);

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
      }).catch(() => {});
      await page.waitForTimeout(2000);

      // Extra scroll — some stores (Snidel-style) don't inject until scrolled twice
      await page.evaluate(() => {
        const height =
          document?.body?.scrollHeight ||
          document?.documentElement?.scrollHeight ||
          2000;
        window.scrollTo(0, height);
      }).catch(() => {});
      await page.waitForTimeout(1000);

      if (phase === "widget" || phase === "events") {
        // Wait for product form if present — some stores inject VS only after form is ready
        await page.waitForSelector("form.js-product-form", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // Early exit: if a widget container is already in the DOM, pass immediately
        // without waiting for /product/check (handles slow-PDC stores like Brooks Brothers)
        const earlyWidget = await page.evaluate(() => {
          const selectors = [
            "#vs-inpage",
            "#vs-inpage-mini",
            "#vs-inpage-luxury",
            "#vs-legacy-inpage",
            "#vs-kid",
            "#vs-smart-table",
            "#vs-placeholder-cart",
            ".vs-placeholder-inpage",
            "#inpage-placeholder-wrapper",
            "#virtusize-button",
            "#router-view-wrapper",  // Brooks Brothers JP and similar stores
          ];
          return selectors.some((sel) => !!document.querySelector(sel));
        }).catch(() => false);

        if (earlyWidget) {
          logMonitorResult({
            storeAlias,
            storeId,
            url: resolvedUrl,
            phase,
            status: "passed",
            reason: "widget_detected",
            fromFallback: fromFallback || false,
            browser: testInfo.project.name,
            durationMs: Date.now() - startTime,
            widgetVisibleMs: Date.now() - startTime,
          });
          return;
        }

        // Step 1: Wait for product/check API response (up to 20s)
        const pdcStart = Date.now();
        while (Date.now() - pdcStart < 20000) {
          if (pdc.validProduct !== undefined) break;
          await page.waitForTimeout(200);
        }

        // If PDC hasn't resolved yet, check whether VS containers are already in the DOM.
        // Their presence means the VS script loaded and is initializing — wait longer.
        if (pdc.validProduct === undefined) {
          const vsContainerExists = await page.evaluate(() =>
            !!(
              document.querySelector("#vs-inpage") ||
              document.querySelector("#vs-inpage-mini") ||
              document.querySelector("#vs-smart-table") ||
              document.querySelector("#vs-kid") ||
              document.querySelector("#vs-placeholder-cart") ||
              document.querySelector(".vs-placeholder-inpage") ||
              document.querySelector("#inpage-placeholder-wrapper")
            )
          ).catch(() => false);

          if (vsContainerExists) {
            const extStart = Date.now();
            while (Date.now() - extStart < 20000) {
              if (pdc.validProduct !== undefined) break;
              await page.waitForTimeout(200);
            }
          }
        }

        // Step 2: If product is not supported, skip — widget will never mount
        if (pdc.validProduct === false) {
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

        // Step 3: If validProduct is true, widget must appear — verify DOM.
        // If PDC never fired (undefined), do a quick synchronous check only to avoid
        // burning the full 20s timeout and racing against the test timeout ceiling.
        const checkWidgetInDOM = () => page.evaluate(() => {
          const shadowSelectors = [
            "#vs-inpage",
            "#vs-inpage-mini",
            "#vs-inpage-luxury",
            "#vs-legacy-inpage",
            "#vs-kid",
            "#router-view-wrapper",
          ];
          const hasWidget = shadowSelectors.some((sel) => {
            const el = document.querySelector(sel);
            return el && el.shadowRoot;
          });
          // #vs-smart-table does not use Shadow DOM — check presence only
          const hasSmartTable = !!document.querySelector("#vs-smart-table");
          const hasPlaceholder = !!(
            document.querySelector("#vs-placeholder-cart") ||
            document.querySelector(".vs-placeholder-inpage") ||
            document.querySelector("#inpage-placeholder-wrapper")
          );
          const hasEntryButton = !!document.querySelector("#virtusize-button");
          return hasWidget || hasSmartTable || hasPlaceholder || hasEntryButton;
        });

        let widgetFound;
        if (pdc.validProduct === undefined) {
          // PDC never fired — quick check only, don't wait
          widgetFound = await checkWidgetInDOM().catch(() => false);
        } else {
          // PDC confirmed valid product — wait up to 20s for widget to mount
          widgetFound = await page.waitForFunction(
            () => {
              const shadowSelectors = [
                "#vs-inpage",
                "#vs-inpage-mini",
                "#vs-inpage-luxury",
                "#vs-legacy-inpage",
                "#vs-kid",
                "#router-view-wrapper",
              ];
              const hasWidget = shadowSelectors.some((sel) => {
                const el = document.querySelector(sel);
                return el && el.shadowRoot;
              });
              const hasSmartTable = !!document.querySelector("#vs-smart-table");
              const hasPlaceholder = !!(
                document.querySelector("#vs-placeholder-cart") ||
                document.querySelector(".vs-placeholder-inpage") ||
                document.querySelector("#inpage-placeholder-wrapper")
              );
              const hasEntryButton = !!document.querySelector("#virtusize-button");
              return hasWidget || hasSmartTable || hasPlaceholder || hasEntryButton;
            },
            { timeout: 20000 },
          ).then(() => true).catch(() => false);
        }

        // Step 4: Widget did not appear — report as widget_missing
        if (!widgetFound) {
          logMonitorResult({
            storeAlias,
            storeId,
            url: resolvedUrl,
            phase,
            status: "widget_missing",
            reason: "widget_not_rendered",
            error: `validProduct=${pdc.validProduct}`,
            browser: testInfo.project.name,
            durationMs: Date.now() - startTime,
          });
          return;
        }

        widgetVisibleMs = Date.now() - startTime;
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
        widgetVisibleMs,
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

  // Write each result to its own file for local dashboard aggregation
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(
    join(RESULTS_DIR, `${result.storeAlias}.json`),
    JSON.stringify(result)
  );
}

test.afterAll(async () => {
  if (!existsSync(RESULTS_DIR)) return;

  const healthFile = join(__dirname, "../data/storeHealth.json");
  const health = existsSync(healthFile)
    ? JSON.parse(readFileSync(healthFile, "utf8"))
    : {};

  // Aggregate per-store result files
  const { readdirSync } = await import("fs");
  const results = readdirSync(RESULTS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(join(RESULTS_DIR, f), "utf8")));

  const summary = {
    total: results.length,
    passed: results.filter(r => r.status === "passed").length,
    widgetMissing: results.filter(r => r.status === "widget_missing").length,
    skipped: results.filter(r => r.status === "skipped").length,
    failed: results.filter(r => r.status === "failed").length,
    fallbackUsed: results.filter(r => r.fromFallback).length,
  };

  const ongoingMissing = Object.entries(health)
    .filter(([, v]) => v.consecutiveWidgetMissing > 0)
    .map(([store, v]) => ({ store, consecutiveRuns: v.consecutiveWidgetMissing }))
    .sort((a, b) => b.consecutiveRuns - a.consecutiveRuns);

  const report = {
    timestamp: new Date().toISOString(),
    summary,
    newIssues: results.filter(r => r.status === "failed").map(r => ({ store: r.storeAlias, error: r.error || r.reason })),
    ongoingMissing,
    botProtected: results.filter(r => r.status === "bot_protected").map(r => r.storeAlias),
    skippedStores: results.filter(r => r.status === "skipped").map(r => ({ store: r.storeAlias, reason: r.reason })),
    githubRunUrl: process.env.GITHUB_RUN_URL || null,
  };

  const dataDir = join(__dirname, "../data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "monitor-report.json"), JSON.stringify(report, null, 2));
  console.log("\nMonitor report written to data/monitor-report.json");
});

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

    // Click accordion trigger used by snidel/gelato_pique (enf platform)
    // — widget only mounts after this element is clicked
    const enfTrigger = document.querySelector("h3.enf-detail-link");
    if (enfTrigger) {
      enfTrigger.scrollIntoView({ block: "center" });
      enfTrigger.click();
    }

    // Click Virtusize button if present (button-trigger stores)
    const vsButton = document.querySelector("#virtusize-button");
    if (vsButton) {
      vsButton.scrollIntoView({ block: "center" });
      vsButton.click();
    }
  }).catch(() => {});

  await page.waitForTimeout(1000);
}
