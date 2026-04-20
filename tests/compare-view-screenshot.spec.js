/**
 * Virtusize compare view screenshot test.
 *
 * All URLs run in a single shared browser context so bag onboarding state
 * (cookies / localStorage) persists across tabs. The first bag product that
 * needs onboarding runs it; every subsequent bag product detects the existing
 * session and goes straight to the compare view.
 *
 * Screenshots are saved to test-results/compare-view-screenshots/ and an HTML
 * gallery (index.html) is generated there after all tests complete.
 * Screenshots are also attached to the Playwright HTML report.
 *
 * Output: logs COMPARE_VIEW_RESULT JSON lines per product.
 *
 * Usage:
 *   npx playwright test compare-view-screenshot --reporter=list
 *
 * Custom URLs file (optional):
 *   TEST_URLS_FILE=data/compare-view-screenshot-urls.txt npx playwright test compare-view-screenshot
 */

import { test } from "@playwright/test";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { startPDCWatcher } from "../utils/pdcWatcher.js";
import { isBagProduct } from "../utils/inpageFlow.js";
import { completeOnboarding } from "../utils/completeOnboarding.js";

const RECOMMENDATION_EVENTS = [
  "user-got-size-recommendation",
  "user-opened-panel-tryiton",
  "user-saw-measurements-view",
  "user-opened-panel-compare",
];

function startRecommendationDetector(page) {
  let ready = false;
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    if (!req.url().match(/events\..*virtusize\.(jp|com|kr)/)) return;
    try {
      const name = req.postDataJSON()?.name;
      if (RECOMMENDATION_EVENTS.includes(name)) ready = true;
    } catch {}
  });
  return { isReady: () => ready };
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const urlsFile = process.env.TEST_URLS_FILE
  ? join(__dirname, "..", process.env.TEST_URLS_FILE)
  : join(__dirname, "../data/compare-view-screenshot-urls.txt");

if (!existsSync(urlsFile)) {
  throw new Error(`URLs file not found: ${urlsFile}`);
}

const urls = readFileSync(urlsFile, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

if (urls.length === 0) {
  throw new Error(`No URLs found in ${urlsFile}`);
}

// Default (non-serial) mode — a failed test does NOT cancel subsequent tests.
// Run with --workers=1 to keep all tests in the same worker so the shared
// browser context is visible to all of them.

// Date folder for this run — screenshots go into test-results/compare-view-screenshots/YYYY-MM-DD/
const runDate = new Date().toISOString().slice(0, 10);

test.setTimeout(180000); // 3 min per URL — Bottega Veneta pages load slowly

// Shared browser context — created once, closed in afterAll.
let sharedContext = null;

test.beforeAll(async ({ browser }) => {
  sharedContext = await browser.newContext();
});

test.afterAll(async () => {
  await sharedContext?.close().catch(() => {});

  // Generate local HTML gallery for this run's date folder
  const screenshotsDir = join(__dirname, "../test-results/compare-view-screenshots", runDate);
  if (!existsSync(screenshotsDir)) return;

  const manifestPath = join(screenshotsDir, "manifest.json");
  const images = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")).filter(({ sku }) =>
        existsSync(join(screenshotsDir, `${sku}.png`))
      )
    : [];

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Compare View Screenshot Gallery</title>
  <style>
    body { font-family: sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
    h1 { font-size: 18px; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; }
    .card { background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
    .card img { width: 100%; display: block; }
    .card .label { padding: 8px 12px; font-size: 12px; color: #555; word-break: break-all; }
    .card .sku { padding: 4px 12px 8px; font-size: 13px; font-weight: bold; color: #222; }
  </style>
</head>
<body>
  <h1>Compare View — ${images.length} products</h1>
  <div class="grid">
    ${images
      .map(
        ({ sku, url }) => `
    <div class="card">
      <img src="${sku}.png" alt="${sku}">
      <div class="sku">${sku}</div>
      <div class="label"><a href="${url}" target="_blank">${url}</a></div>
    </div>`
      )
      .join("")}
  </div>
</body>
</html>`;

  writeFileSync(join(screenshotsDir, "index.html"), html);
  console.log(`\nGallery ready: open test-results/compare-view-screenshots/index.html`);
});

// ── One test per URL ──────────────────────────────────────────────────────────

for (const url of urls) {
  test(url, async ({}, testInfo) => {
    const page = await sharedContext.newPage();
    // Explicitly cap page timeouts — shared-context pages don't inherit test-runner timeout management
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);
    const startTime = Date.now();

    try {
      // Hide headless indicators and expose getWidgetHost helper
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        document.hasFocus = () => true;
        window.getWidgetHost = () =>
          document.querySelector("#router-view-wrapper") ||
          document.querySelector("#vs-aoyama")?.nextElementSibling;
      });

      const pdc = startPDCWatcher(page);
      const eventWatcher = startRecommendationDetector(page);

      // ── Navigate ────────────────────────────────────────────────────────────
      const navOk = await page
        .goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })
        .catch(() => null);
      if (!navOk) {
        logResult({ url, status: "skipped", reason: "navigation failed", durationMs: Date.now() - startTime });
        return;
      }
      // Accept cookie banner if present
      await page.locator("#onetrust-accept-btn-handler").click({ timeout: 5000 }).catch(() => {});

      // Scroll to trigger lazy-mounted widgets
      await page.evaluate(() => {
        const el = document.querySelector(
          "#vs-inpage, #vs-inpage-luxury, .vs-placeholder-inpage"
        );
        el
          ? el.scrollIntoView({ block: "center", behavior: "instant" })
          : window.scrollTo(0, 1000);
      }).catch(() => {});
      await page.waitForTimeout(2000);

      // ── Wait for PDC (up to 20s) ────────────────────────────────────────────
      const pdcStart = Date.now();
      while (Date.now() - pdcStart < 20000) {
        if (pdc.validProduct !== undefined) break;
        await page.waitForTimeout(200);
      }

      if (pdc.validProduct !== true) {
        logResult({ url, status: "skipped", reason: `validProduct=${pdc.validProduct}`, durationMs: Date.now() - startTime });
        return;
      }

      const sku = pdc.externalProductId;
      if (!sku) {
        logResult({ url, status: "skipped", reason: "externalProductId missing from PDC", durationMs: Date.now() - startTime });
        return;
      }

      // ── Find and click the inpage open button ───────────────────────────────
      const btnFound = await page
        .waitForFunction(
          () => {
            const root =
              document.querySelector("#vs-inpage")?.shadowRoot ||
              document.querySelector("#vs-inpage-luxury")?.shadowRoot;
            return (
              !!root?.querySelector('[data-test-id="inpage-open-aoyama-btn"]') ||
              !!root?.querySelector('[data-test-id="inpage-luxury-open-aoyama"]')
            );
          },
          { timeout: 30000 }
        )
        .catch(() => null);

      if (!btnFound) {
        logResult({ sku, url, status: "skipped", reason: "inpage button not found", durationMs: Date.now() - startTime });
        return;
      }

      await page.evaluate(() => {
        const root =
          document.querySelector("#vs-inpage")?.shadowRoot ||
          document.querySelector("#vs-inpage-luxury")?.shadowRoot;
        const btn =
          root?.querySelector('[data-test-id="inpage-open-aoyama-btn"]') ||
          root?.querySelector('[data-test-id="inpage-luxury-open-aoyama"]');
        btn?.click();
      }).catch(() => {});

      // Wait for widget shadow root
      await page
        .waitForFunction(() => !!window.getWidgetHost()?.shadowRoot, { timeout: 15000 })
        .catch(() => {});
      await page.waitForTimeout(1500);

      // ── Bag flow ────────────────────────────────────────────────────────────
      if (isBagProduct(pdc)) {
        // Poll up to 15s for the widget to reach a settled state:
        //   • user-opened-panel-compare fires → returning session, compare view already open
        //   • privacy-policy-checkbox appears in shadow root → new session, onboarding needed
        // A synchronous one-shot check races against widget mount and misses the checkbox.
        let needsOnboarding = false;
        const bagSettleStart = Date.now();
        while (Date.now() - bagSettleStart < 15000) {
          if (eventWatcher.isReady()) { needsOnboarding = false; break; }
          const hasCheckbox = await page.evaluate(() => {
            const root = window.getWidgetHost()?.shadowRoot;
            return !!root?.querySelector('[data-test-id="privacy-policy-checkbox"]');
          }).catch(() => false);
          if (hasCheckbox) { needsOnboarding = true; break; }
          await page.waitForTimeout(300);
        }

        if (needsOnboarding) {
          // ── Case A: new session — run full bag onboarding ───────────────────
          await page.evaluate(() => {
            const root = window.getWidgetHost()?.shadowRoot;
            const checkbox = root?.querySelector('[data-test-id="privacy-policy-checkbox"]');
            if (!checkbox) return;
            // Prevent the privacy policy link from intercepting the click
            const linkButton = root.querySelector?.("#linkText");
            if (linkButton) linkButton.removeAttribute("id");
            checkbox.click();
          }).catch(() => {});
          await page.waitForTimeout(1000);

          const nextBtn = page.locator('[data-test-id="accept-privacy-policy-btn"]');
          await nextBtn.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
          await nextBtn.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(2000);

          await page
            .waitForFunction(
              () => !!window.getWidgetHost()?.shadowRoot?.querySelector("button.everyday-item-btns"),
              { timeout: 20000 }
            )
            .catch(() => {});
          await page.evaluate(() => {
            window.getWidgetHost()?.shadowRoot?.querySelector("button.everyday-item-btns")?.click();
          }).catch(() => {});
          await page.waitForTimeout(1500);

          await page
            .waitForFunction(
              () => !!window.getWidgetHost()?.shadowRoot?.querySelector(".hidden-select"),
              { timeout: 10000 }
            )
            .catch(() => {});
          await page.evaluate(() => {
            const root = window.getWidgetHost()?.shadowRoot;
            const select = root?.querySelector(".hidden-select");
            if (!select) return;
            select.value = select.options[1]?.value ?? select.options[0]?.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }).catch(() => {});
          await page.waitForTimeout(2000);
        }
        // Case B: existing session — compare view loads automatically, no action needed.

        // ── Compare view guard ──────────────────────────────────────────────
        // Verify the compare view has rendered (onboarding elements are gone).
        // If still showing onboarding/loading after 10 s, skip rather than capture a bad shot.
        const compareViewReady = await page
          .waitForFunction(
            () => {
              const root = window.getWidgetHost()?.shadowRoot;
              if (!root) return false;
              const hasPrivacyPolicy = !!root.querySelector('[data-test-id="privacy-policy-checkbox"]');
              const hasBudgetScreen = !!root.querySelector("button.everyday-item-btns");
              return !hasPrivacyPolicy && !hasBudgetScreen;
            },
            { timeout: 15000 }
          )
          .catch(() => null);

        if (!compareViewReady) {
          logResult({ sku, url, status: "error", reason: "compare view never rendered", durationMs: Date.now() - startTime });
          return;
        }

        // Wait for user-opened-panel-compare event (up to 10s if not already fired), then 3s to let it fully paint
        if (!eventWatcher.isReady()) {
          const compareEventStart = Date.now();
          while (Date.now() - compareEventStart < 10000) {
            if (eventWatcher.isReady()) break;
            await page.waitForTimeout(300);
          }
        }
        await page.waitForTimeout(3000);
      } else {
        // ── Apparel / footwear flow ─────────────────────────────────────────
        await completeOnboarding(page);

        const recStart = Date.now();
        while (Date.now() - recStart < 30000) {
          if (eventWatcher.isReady()) break;
          await page.waitForTimeout(300);
        }
        await page.waitForTimeout(1500);
      }

      // ── Screenshot ─────────────────────────────────────────────────────────
      const widgetHandle = await page.evaluateHandle(() => window.getWidgetHost()).catch(() => null);
      const widgetElement = widgetHandle?.asElement() ?? null;
      const screenshot =
        (widgetElement
          ? await widgetElement.screenshot({ timeout: 10000 }).catch(() => null)
          : null) ?? (await page.screenshot({ fullPage: false }).catch(() => null));

      if (!screenshot) {
        logResult({ sku, url, status: "error", reason: "screenshot failed", durationMs: Date.now() - startTime });
        return;
      }

      // ── Save to disk ────────────────────────────────────────────────────────
      const screenshotsDir = join(__dirname, "../test-results/compare-view-screenshots", runDate);
      mkdirSync(screenshotsDir, { recursive: true });
      writeFileSync(join(screenshotsDir, `${sku}.png`), screenshot);

      const manifestPath = join(screenshotsDir, "manifest.json");
      const manifest = existsSync(manifestPath)
        ? JSON.parse(readFileSync(manifestPath, "utf8"))
        : [];
      const existingIdx = manifest.findIndex((e) => e.sku === sku);
      if (existingIdx >= 0) manifest[existingIdx] = { sku, url };
      else manifest.push({ sku, url });
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      await testInfo.attach(`${sku}.png`, { body: screenshot, contentType: "image/png" });

      logResult({ sku, url, status: "screenshot_taken", durationMs: Date.now() - startTime });
    } finally {
      // Close tab — context stays open so cookies/storage persist for next URL
      await page.close().catch(() => {});
    }
  });
}

function logResult(result) {
  console.log(`COMPARE_VIEW_RESULT: ${JSON.stringify(result)}`);
}
