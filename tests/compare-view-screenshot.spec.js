/**
 * Virtusize compare view screenshot test.
 *
 * For each bag product URL, opens the Virtusize aoyama widget, goes through
 * the bag flow, and screenshots the result for manual visual review.
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
import { startVirtusizeEventWatcher } from "../utils/eventWatcher.js";

test.setTimeout(180000);

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


for (const url of urls) {
  test(url, async ({ page }, testInfo) => {
    const startTime = Date.now();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      document.hasFocus = () => true;
      window.getWidgetHost = () =>
        document.querySelector("#router-view-wrapper") ||
        document.querySelector("#vs-aoyama")?.nextElementSibling;
    });

    const pdc = startPDCWatcher(page);
    const eventWatcher = startVirtusizeEventWatcher(page);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("load");

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
    });
    await page.waitForTimeout(2000);

    // Wait for PDC (up to 40s)
    const pdcStart = Date.now();
    while (Date.now() - pdcStart < 40000) {
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

    // Wait for inpage open button in shadow root
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
        { timeout: 15000 }
      )
      .catch(() => null);

    if (!btnFound) {
      logResult({ sku, url, status: "skipped", reason: "inpage button not found", durationMs: Date.now() - startTime });
      return;
    }

    // Click the inpage open button
    await page.evaluate(() => {
      const root =
        document.querySelector("#vs-inpage")?.shadowRoot ||
        document.querySelector("#vs-inpage-luxury")?.shadowRoot;
      const btn =
        root?.querySelector('[data-test-id="inpage-open-aoyama-btn"]') ||
        root?.querySelector('[data-test-id="inpage-luxury-open-aoyama"]');
      btn?.click();
    });

    // Wait for aoyama widget shadow root to be ready
    await page.waitForFunction(() => !!window.getWidgetHost()?.shadowRoot, {
      timeout: 15000,
    });
    await page.waitForTimeout(1500);

    if (isBagProduct(pdc)) {
      // ── Bag flow: privacy policy + budget selection ─────────────────────────
      await page.evaluate(() => {
        const root = window.getWidgetHost()?.shadowRoot;
        const checkbox = root?.querySelector('[data-test-id="privacy-policy-checkbox"]');
        if (!checkbox) return;
        const linkButton = root.querySelector?.("#linkText");
        if (linkButton) linkButton.removeAttribute("id");
        checkbox.click();
      });
      await page.waitForTimeout(1000);

      const nextBtn = page.locator('[data-test-id="accept-privacy-policy-btn"]');
      await nextBtn.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      await nextBtn.click().catch(() => {});
      await page.waitForTimeout(2000);

      await page
        .waitForFunction(
          () => !!window.getWidgetHost()?.shadowRoot?.querySelector('button.everyday-item-btns'),
          { timeout: 10000 }
        )
        .catch(() => {});
      await page.evaluate(() => {
        window.getWidgetHost()?.shadowRoot?.querySelector('button.everyday-item-btns')?.click();
      });
      await page.waitForTimeout(1500);

      await page.evaluate(() => {
        const root = window.getWidgetHost()?.shadowRoot;
        const select = root?.querySelector(".hidden-select");
        if (!select) return;
        select.value = select.options[1]?.value ?? select.options[0]?.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForTimeout(3000);

    } else {
      // ── Apparel/footwear flow: complete onboarding then wait for compare view
      await completeOnboarding(page);

      // Wait for the recommendation to appear (event-based, up to 30s)
      const recStart = Date.now();
      while (Date.now() - recStart < 30000) {
        const events = eventWatcher.getEvents();
        if (
          events.some((e) => e.startsWith("user-got-size-recommendation")) ||
          events.some((e) => e.startsWith("user-opened-panel-tryiton")) ||
          events.some((e) => e.startsWith("user-saw-measurements-view"))
        ) break;
        await page.waitForTimeout(300);
      }
      await page.waitForTimeout(1500);
    }

    // Screenshot the widget host element, fall back to full page
    const widgetHost = page.locator("#router-view-wrapper").first();
    const widgetVisible = await widgetHost.isVisible().catch(() => false);
    const screenshot = widgetVisible
      ? await widgetHost.screenshot({ timeout: 10000 }).catch(() => null)
      : await page.screenshot({ fullPage: false }).catch(() => null);

    if (!screenshot) {
      logResult({ sku, url, status: "error", reason: "screenshot failed", durationMs: Date.now() - startTime });
      return;
    }

    // Save screenshot to disk
    const screenshotsDir = join(__dirname, "../test-results/compare-view-screenshots");
    mkdirSync(screenshotsDir, { recursive: true });
    writeFileSync(join(screenshotsDir, `${sku}.png`), screenshot);

    // Append to manifest so afterAll can build the gallery without re-parsing URLs
    const manifestPath = join(screenshotsDir, "manifest.json");
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
    if (!manifest.some((e) => e.sku === sku)) manifest.push({ sku, url });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Also attach to Playwright HTML report
    await testInfo.attach(`${sku}.png`, { body: screenshot, contentType: "image/png" });

    logResult({ sku, url, status: "screenshot_taken", durationMs: Date.now() - startTime });
  });
}

function logResult(result) {
  console.log(`COMPARE_VIEW_RESULT: ${JSON.stringify(result)}`);
}

// Generate a simple HTML gallery after all tests
test.afterAll(async () => {
  const screenshotsDir = join(__dirname, "../test-results/compare-view-screenshots");
  if (!existsSync(screenshotsDir)) return;

  const manifestPath = join(screenshotsDir, "manifest.json");
  const images = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")).filter(({ sku }) => existsSync(join(screenshotsDir, `${sku}.png`)))
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
    ${images.map(({ sku, url }) => `
    <div class="card">
      <img src="${sku}.png" alt="${sku}">
      <div class="sku">${sku}</div>
      <div class="label"><a href="${url}" target="_blank">${url}</a></div>
    </div>`).join("")}
  </div>
</body>
</html>`;

  const galleryPath = join(screenshotsDir, "index.html");
  writeFileSync(galleryPath, html);
  console.log(`\nGallery ready: open test-results/compare-view-screenshots/index.html`);
});
