import { test, expect } from "@playwright/test";
import { startVirtusizeEventWatcher } from "../utils/eventWatcher.js";
import { startPDCWatcher } from "../utils/pdcWatcher.js";
import { blockMarketingScripts } from "../utils/blockMarketingScripts.js";
import { resolveTestUrl } from "../utils/fetchRandomProduct.js";
import { BOT_PROTECTED_DOMAINS } from "../config/stores.js";

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
  eventWatcher.setPhase("addtocart");
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
    console.log("Navigating to:", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    console.log("Page loaded");

    // Scroll to widget to trigger IntersectionObserver
    await page.evaluate(() => {
      const widget = document.querySelector(
        "#vs-inpage, #vs-inpage-luxury, #vs-legacy-inpage, #vs-kid, #vs-placeholder-cart",
      );
      if (widget) widget.scrollIntoView({ block: "center", behavior: "instant" });
      else window.scrollTo({ top: 1000, behavior: "instant" });
    });

    // Wait for widget to appear
    await page.waitForFunction(
      () =>
        document.querySelector("#vs-placeholder-cart") ||
        document.querySelector("#vs-inpage") ||
        document.querySelector("#vs-inpage-luxury") ||
        document.querySelector("#vs-legacy-inpage"),
      { timeout: 30000 },
    );
    console.log("Widget element found");

    await page.waitForTimeout(2000);

    // Click the accordion trigger if needed (e.g. enfold/ec-store.net)
    const accordionClicked = await page.evaluate(() => {
      const trigger = document.querySelector("h3.enf-detail-link");
      if (trigger) { trigger.click(); return true; }
      return false;
    });
    if (accordionClicked) await page.waitForTimeout(1000);

    // Open the widget
    await page.evaluate((sel) => {
      document.querySelector(sel)?.scrollIntoView({ block: "center" });
    }, ":is(#vs-inpage, #vs-inpage-luxury, #vs-legacy-inpage)");

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

    // Detect new vs returning user:
    // - Returning: add-to-cart button appears immediately on result screen
    // - New: onboarding form appears first (has age input or see-ideal-fit-btn)
    const screenType = await page.waitForFunction(
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

    console.log(`Screen: ${screenType}`);

    if (screenType === "onboarding") {
      console.log("New user — completing onboarding");
      await completeOnboardingInline(page);
      console.log("Onboarding done — waiting for result screen");

      // Wait for add-to-cart after onboarding
      await page.waitForFunction(
        () => !!findInShadow('[data-test-id="add-to-cart-button"]'),
        { timeout: 30000 },
      );
    }

    console.log("Result screen visible — clicking Add to Cart");
    await page.evaluate(() => {
      findInShadow('[data-test-id="add-to-cart-button"]')?.click();
    });
    console.log("Add to Cart clicked");

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
// Inline onboarding for add-to-cart flow
// (uses findInShadow instead of #router-view-wrapper handle)
// --------------------------------------------------

async function completeOnboardingInline(page) {
  const fill = async (testId, value) => {
    await page.waitForFunction(
      (id) => !!findInShadow(`[data-test-id="${id}"] input`),
      { timeout: 15000 },
      testId,
    );
    await page.evaluate(({ id, val }) => {
      const input = findInShadow(`[data-test-id="${id}"] input`);
      if (!input) throw new Error(`Input not found: ${id}`);
      input.focus();
      input.value = val;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
    }, { id: testId, val: value });
    await page.waitForTimeout(2000);
  };

  await fill("input-age", "35");
  await fill("input-height", "161");
  await fill("input-weight", "54");

  // Privacy policy
  const hasPrivacy = await page.evaluate(
    () => !!findInShadow('[data-test-id="privacy-policy-checkbox"]'),
  );
  if (hasPrivacy) {
    await page.evaluate(() => {
      const cb = findInShadow('[data-test-id="privacy-policy-checkbox"]');
      if (cb && !cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await page.waitForTimeout(2000);
  }

  // Submit
  await page.waitForFunction(
    () => !!findInShadow('[data-test-id="see-ideal-fit-btn"]'),
    { timeout: 10000 },
  );
  await page.evaluate(() => {
    findInShadow('[data-test-id="see-ideal-fit-btn"]')?.click();
  });
}

function logResult(result) {
  console.log("QA_RESULT:", JSON.stringify(result));
}
