import { test } from "@playwright/test";
import { startVirtusizeEventWatcher } from "../utils/eventWatcher.js";
import { startPDCWatcher } from "../utils/pdcWatcher.js";
import { blockMarketingScripts } from "../utils/blockMarketingScripts.js";
import { resolveTestUrl } from "../utils/fetchRandomProduct.js";
import { BOT_PROTECTED_DOMAINS } from "../config/stores.js";
import { completeOnboarding } from "../utils/completeOnboarding.js";

test.setTimeout(180000);

test("Add to Cart flow", async ({ page }, testInfo) => {
  const startTime = Date.now();

  const url = await resolveTestUrl(
    "https://www.underarmour.co.jp/f/dsg-1072366",
  );

  console.log("Testing URL:", url);

  // Bot-protection check
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    if (BOT_PROTECTED_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
      logResult({ url, status: "skipped", reason: "bot_protected", browser: testInfo.project.name, durationMs: Date.now() - startTime });
      return;
    }
  } catch {}

  const eventWatcher = startVirtusizeEventWatcher(page);
  const pdc = startPDCWatcher(page);

  await page.addInitScript(() => {
    window.getWidgetHost = () =>
      document.querySelector("#router-view-wrapper") ||
      document.querySelector("#vs-aoyama")?.nextElementSibling;

    window.findInShadow = (selector) => {
      const walk = (node) => {
        if (!node) return null;
        if (node.querySelector?.(selector)) return node.querySelector(selector);
        for (const el of node.querySelectorAll?.("*") ?? []) {
          if (el.shadowRoot) {
            const found = walk(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      };
      return walk(document);
    };

    // Dismiss marketing overlays
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
    // ── Phase 1: New user ─────────────────────────────────────────────
    eventWatcher.setPhase("new-user");
    console.log("Navigating to:", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    console.log("Page loaded");

    await waitForWidgetAndOpen(page);

    const screenType = await detectScreen(page);
    console.log(`Screen: ${screenType}`);

    if (screenType === "onboarding") {
      console.log("New user — completing onboarding");
      await completeOnboarding(page);
      console.log("Onboarding done — waiting for result screen");
      await page.waitForFunction(
        () => !!findInShadow('[data-test-id="add-to-cart-button"]'),
        { timeout: 30000 },
      );
    }

    console.log("[new-user] Clicking Add to Cart");
    await page.evaluate(() => {
      findInShadow('[data-test-id="add-to-cart-button"]')?.click();
    });
    await page.waitForTimeout(2000);
    eventWatcher.logPhaseSummary();

    // ── Phase 2: Returning user (reload) ──────────────────────────────
    eventWatcher.setPhase("returning-user");
    eventWatcher.reset();
    console.log("Reloading for returning user...");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    await waitForWidgetAndOpen(page);

    // Returning user — result screen should appear directly
    await page.waitForFunction(
      () => !!findInShadow('[data-test-id="add-to-cart-button"]'),
      { timeout: 20000 },
    );
    console.log("[returning-user] Result screen visible — clicking Add to Cart");
    await page.evaluate(() => {
      findInShadow('[data-test-id="add-to-cart-button"]')?.click();
    });
    await page.waitForTimeout(2000);
    eventWatcher.logPhaseSummary();

    logResult({
      url,
      store: pdc.store,
      productType: pdc.productType,
      status: "passed",
      browser: testInfo.project.name,
      durationMs: Date.now() - startTime,
    });

  } catch (error) {
    logResult({
      url,
      status: "failed",
      browser: testInfo.project.name,
      error: error.message,
      durationMs: Date.now() - startTime,
    });
    throw error;
  }
});

// --------------------------------------------------
// Helpers
// --------------------------------------------------

async function waitForWidgetAndOpen(page) {
  await page.evaluate(() => {
    const widget = document.querySelector(
      "#vs-inpage, #vs-inpage-luxury, #vs-legacy-inpage, #vs-placeholder-cart",
    );
    if (widget) widget.scrollIntoView({ block: "center", behavior: "instant" });
    else window.scrollTo({ top: 1000, behavior: "instant" });
  });

  await page.waitForFunction(
    () =>
      document.querySelector("#vs-placeholder-cart") ||
      document.querySelector("#vs-inpage") ||
      document.querySelector("#vs-inpage-luxury") ||
      document.querySelector("#vs-legacy-inpage"),
    { timeout: 30000 },
  );

  await page.waitForTimeout(2000);

  // Accordion trigger (e.g. enfold)
  const accordionClicked = await page.evaluate(() => {
    const trigger = document.querySelector("h3.enf-detail-link");
    if (trigger) { trigger.click(); return true; }
    return false;
  });
  if (accordionClicked) await page.waitForTimeout(1000);

  // Click open button
  if (await page.evaluate(() => !!document.querySelector("#vs-inpage") || !!document.querySelector("#vs-inpage-luxury"))) {
    const isLuxury = await page.evaluate(() => !!document.querySelector("#vs-inpage-luxury"));
    await page.waitForFunction(
      (luxury) => {
        const root = (
          document.querySelector("#vs-inpage") ||
          document.querySelector("#vs-inpage-luxury")
        )?.shadowRoot;
        return (
          !!root?.querySelector('[data-test-id="inpage-open-aoyama-btn"]') ||
          !!root?.querySelector('[data-test-id="inpage-luxury-open-aoyama"]') ||
          (!luxury && !!root?.querySelector('[data-test-id="gift-cta"]'))
        );
      },
      { timeout: 15000 },
      isLuxury,
    );
    await page.evaluate((luxury) => {
      const root = (
        document.querySelector("#vs-inpage") ||
        document.querySelector("#vs-inpage-luxury")
      )?.shadowRoot;
      const btn =
        root?.querySelector('[data-test-id="inpage-open-aoyama-btn"]') ||
        root?.querySelector('[data-test-id="inpage-luxury-open-aoyama"]') ||
        (!luxury && root?.querySelector('[data-test-id="gift-cta"]')) ||
        null;
      btn?.click();
    }, isLuxury);
  } else {
    await page.locator("#vs-legacy-inpage").click({ force: true });
  }

  console.log("Widget opened");
  await page.waitForTimeout(2000);
}

async function detectScreen(page) {
  return page.waitForFunction(
    () => {
      const hasAddToCart = !!findInShadow('[data-test-id="add-to-cart-button"]');
      const hasOnboarding =
        !!findInShadow('[data-test-id="input-age"]') ||
        !!findInShadow('[data-test-id="see-ideal-fit-btn"]');
      if (hasAddToCart) return "result";
      if (hasOnboarding) return "onboarding";
      return null;
    },
    { timeout: 20000 },
  ).then((h) => h.jsonValue());
}

function logResult(result) {
  console.log("QA_RESULT:", JSON.stringify(result));
}
