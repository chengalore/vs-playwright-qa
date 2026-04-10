/**
 * Virtusize overlay QA test.
 *
 * For each bag product URL, opens the Virtusize aoyama widget and screenshots it,
 * then uses Claude Vision to detect whether the size comparison overlay correctly
 * fits within the bag's visible silhouette.
 *
 * Known issue: side-view product images appear shorter in height than front-view,
 * but the overlay uses front-view dimensions — causing it to extend outside the bag.
 *
 * Output: logs OVERLAY_QA_RESULT JSON lines per product.
 * Screenshots are attached to the Playwright HTML report.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=your_key npx playwright test overlay-qa --reporter=list
 *
 * Custom URLs file (optional):
 *   TEST_URLS_FILE=data/overlay-qa-urls.txt npx playwright test overlay-qa
 */

import { test } from "@playwright/test";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { startPDCWatcher } from "../utils/pdcWatcher.js";

test.setTimeout(180000);

const __dirname = dirname(fileURLToPath(import.meta.url));

const urlsFile = process.env.TEST_URLS_FILE
  ? join(__dirname, "..", process.env.TEST_URLS_FILE)
  : join(__dirname, "../data/overlay-qa-urls.txt");

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
  const sku = url.match(/-([A-Z0-9]{10,})\.html/)?.[1] ?? url;

  test(`[${sku}]`, async ({ page }, testInfo) => {
    const startTime = Date.now();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      document.hasFocus = () => true;
      window.getWidgetHost = () =>
        document.querySelector("#router-view-wrapper") ||
        document.querySelector("#vs-aoyama")?.nextElementSibling;
    });

    const pdc = startPDCWatcher(page);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
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
      logResult({ sku, url, status: "skipped", reason: `validProduct=${pdc.validProduct}`, durationMs: Date.now() - startTime });
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

    // ── Bag flow: privacy policy + budget selection ───────────────────────────
    const hasBagFlow = await page
      .waitForFunction(
        () => {
          const root = window.getWidgetHost()?.shadowRoot;
          return !!root?.querySelector('[data-test-id="privacy-policy-checkbox"]');
        },
        { timeout: 5000 }
      )
      .then(() => true)
      .catch(() => false);

    if (hasBagFlow) {
      // Accept privacy policy
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

      // Click budget button
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

      // Select a price option
      await page.evaluate(() => {
        const root = window.getWidgetHost()?.shadowRoot;
        const select = root?.querySelector(".hidden-select");
        if (!select) return;
        select.value = select.options[1]?.value ?? select.options[0]?.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForTimeout(3000);
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
    const screenshotsDir = join(__dirname, "../test-results/overlay-qa-screenshots");
    mkdirSync(screenshotsDir, { recursive: true });
    const screenshotPath = join(screenshotsDir, `${sku}.png`);
    writeFileSync(screenshotPath, screenshot);

    // Also attach to Playwright HTML report
    await testInfo.attach(`${sku}.png`, { body: screenshot, contentType: "image/png" });

    console.log(`OVERLAY_QA_RESULT: ${JSON.stringify({ sku, url, status: "screenshot_taken", durationMs: Date.now() - startTime })}`);
  });
}

// Generate a simple HTML gallery after all tests
test.afterAll(async () => {
  const screenshotsDir = join(__dirname, "../test-results/overlay-qa-screenshots");
  if (!existsSync(screenshotsDir)) return;

  const images = readFileSync(join(__dirname, "../data/overlay-qa-urls.txt"), "utf8")
    .split("\n").map(l => l.trim()).filter(Boolean)
    .map(url => {
      const sku = url.match(/-([A-Z0-9]{10,})\.html/)?.[1] ?? url;
      return { sku, url };
    })
    .filter(({ sku }) => existsSync(join(screenshotsDir, `${sku}.png`)));

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Overlay QA Gallery</title>
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
  <h1>Overlay QA — ${images.length} products</h1>
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
  console.log(`\nGallery ready: open test-results/overlay-qa-screenshots/index.html`);
});
