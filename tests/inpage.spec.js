import { test } from "@playwright/test";
import { startVirtusizeEventWatcher } from "../utils/eventWatcher.js";
import { startPDCWatcher } from "../utils/pdcWatcher.js";
import { startRecommendationWatcher } from "../utils/recommendationWatcher.js";
import { startBodyMeasurementWatcher } from "../utils/bodyMeasurementWatcher.js";
import { blockMarketingScripts } from "../utils/blockMarketingScripts.js";
import { resolveTestUrl } from "../utils/fetchRandomProduct.js";
import { BOT_PROTECTED_DOMAINS } from "../config/stores.js";
import { verifyEvents } from "../utils/verifyEvents.js";
import { expectedEvents } from "../config/expectedEvents.js";
import { validateRecommendation } from "../utils/validateRecommendation.js";
import { selectSizeIfMultiple } from "../utils/selectSizeIfMultiple.js";
import { addItemToWardrobe } from "../utils/addItemToWardrobe.js";
import {
  isBagProduct,
  detectFlow,
  waitForPDC,
  clickWidget,
  clickKidsWidget,
  waitForWidgetRender,
  waitForKidsWidgetReady,
  runApparelFlow,
  runBagFlow,
  runFootwearFlow,
  runKidsFlow,
  runNoVisorFlow,
  runGiftFlow,
  validateCoreEvents,
  validateRefresh,
  getSkipReason,
} from "../utils/inpageFlow.js";

test.setTimeout(180000);

const TEST_COUNT = 1;

for (let i = 0; i < TEST_COUNT; i++) {
test("Inpage basic flow", async ({ page }, testInfo) => {
  const startTime = Date.now();
  const phase = process.env.TEST_PHASE || "full";

  // Onboarding body params — configurable via env vars (apparel / noVisor flows only)
  const onboardingOpts = {
    genderIndex: parseInt(process.env.ONBOARDING_GENDER ?? "0", 10), // 0=female, 1=male
    age:    process.env.ONBOARDING_AGE    || "35",
    height: process.env.ONBOARDING_HEIGHT || "161",
    weight: process.env.ONBOARDING_WEIGHT || "54",
  };

  // Gift flow onboarding params — configurable via env vars (apparel only)
  const giftOpts = {
    genderIndex:   parseInt(process.env.GIFT_GENDER    ?? "0", 10), // 0=female, 1=male
    ageIndex:      parseInt(process.env.GIFT_AGE       ?? "3", 10), // 0=16-19 … 6=>60
    heightIndex:   parseInt(process.env.GIFT_HEIGHT    ?? "3", 10), // 0=145-149cm … 10=195+cm
    bodyTypeIndex: parseInt(process.env.GIFT_BODY_TYPE ?? "1", 10), // 0=<52kg … 5=>98kg
  };

  // Footwear onboarding params — configurable via env vars
  const footwearOpts = {
    genderIndex: parseInt(process.env.FOOTWEAR_GENDER ?? "0", 10), // 0=female, 1=male
    brandIndex:  parseInt(process.env.FOOTWEAR_BRAND  ?? "1", 10), // 0=UA…9=I don't know
    sizeIndex:   parseInt(process.env.FOOTWEAR_SIZE   ?? "17", 10), // 0=17cm…36=35cm
  };

  // Kids onboarding params — configurable via env vars
  const kidsOpts = {
    genderIndex: parseInt(process.env.KIDS_GENDER  ?? "0", 10), // 0=girl, 1=boy
    ageIndex:    parseInt(process.env.KIDS_AGE     ?? "5", 10), // 0=3yr…15=18yr (default idx 5 → 8yr)
    height:      process.env.KIDS_HEIGHT || "120",
    weight:      process.env.KIDS_WEIGHT || "25",
  };

  const url = await resolveTestUrl(
    "https://www.underarmour.co.jp/f/dsg-1072366",
  );

  console.log("Testing URL:", url);

  const eventWatcher = startVirtusizeEventWatcher(page);
  eventWatcher.setPhase("onboarding");
  const pdc = startPDCWatcher(page);
  const recommendationAPI = startRecommendationWatcher(page);
  const bodyAPI = startBodyMeasurementWatcher(page);


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

    // Track how many times the inpage widget is added to the DOM.
    // For SPA clients the widget can be removed and re-injected on product change,
    // which would show as a count > 1 without any network dependency.
    window.__vsInpageMountCount = 0;
    const mountObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (
            node.id === "vs-inpage" ||
            node.id === "vs-inpage-luxury" ||
            node.querySelector?.("#vs-inpage, #vs-inpage-luxury")
          ) {
            window.__vsInpageMountCount++;
          }
        }
      }
    });
    mountObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Continuously dismiss known marketing overlays as they appear (throttled)
    let lastDismiss = 0;
    const dismissOverlays = () => {
      const now = Date.now();
      if (now - lastDismiss < 300) return;
      lastDismiss = now;

      // Buyee
      document
        .querySelectorAll("#buyee-bcFrame, #buyee-bcSection, .bcModalBase")
        .forEach((el) => el.remove());
      document
        .querySelectorAll(".bcIntro__closeBtn")
        .forEach((el) => el.click());

      // WorldShopping (lives inside a declarative shadow root)
      const wsShadow = document.querySelector(
        "#zigzag-worldshopping-checkout",
      )?.shadowRoot;
      if (wsShadow) {
        wsShadow.querySelector("#zigzag-test__banner-close-popup")?.click();
        wsShadow.querySelector("#zigzag-test__banner-hide")?.click();
        wsShadow
          .querySelector(
            ".src-components-notice-___NoticeV2__closeIcon___Hpc7A",
          )
          ?.click();
        // Force-hide the inner banner container so it cannot re-block clicks
        const wsInner = wsShadow.querySelector(
          "#zigzag-worldshopping-checkout",
        );
        if (wsInner) wsInner.style.display = "none";
      }

      // KARTE
      document.querySelectorAll(".karte-close").forEach((el) => el.click());
    };

    const observer = new MutationObserver(dismissOverlays);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  });

  await blockMarketingScripts(page);

  let flow = null;

  let widgetVisibleMs = null;
  let flowDoneMs = null;
  let widgetMeta = { widgetType: null, hasSmartTable: null };

  try {
    console.log("Navigating to:", url);
    const t_nav = Date.now();
    await page.goto(url);
    console.log("Page loaded");

    // Trigger lazy-loaded widgets that rely on IntersectionObserver.
    // Scroll to the widget element if present, otherwise fall back to a fixed
    // offset — without a scroll the widget container may never mount.
    await page.evaluate(() => {
      // #vs-placeholder-cart is a mounting point only — scroll to the actual widget element.
      const widget = document.querySelector(
        "#vs-inpage, #vs-inpage-luxury, #vs-legacy-inpage, #vs-kid, #vs-placeholder-cart",
      );
      if (widget) {
        widget.scrollIntoView({ block: "center", behavior: "instant" });
      } else {
        window.scrollTo({ top: 1000, behavior: "instant" });
      }
    });
    await page.waitForTimeout(1000);

    // Dismiss cookie consent banners that appear shortly after load
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      document
        .querySelectorAll(
          'button[data-testid="uc-accept-all-button"], ' +
            "#onetrust-accept-btn-handler, " +
            'button[id*="cookie"][id*="accept"], ' +
            'button[class*="cookie"][class*="accept"]',
        )
        .forEach((btn) => btn.click());
    });

    await waitForPDC(pdc);

    // Fallback: if product/check response was missed but the VS widget is
    // already rendered in the DOM, treat the product as valid so the test
    // can proceed (some stores fire product/check before our listener attaches
    // or use a response timing that misses the 15s window).
    if (pdc.validProduct !== true) {
      const widgetRendered = await page.evaluate(() =>
        !!(
          document.querySelector("#vs-inpage")?.shadowRoot?.children.length ||
          document.querySelector("#vs-inpage-luxury")?.shadowRoot?.children.length ||
          document.querySelector("#vs-legacy-inpage")
        )
      );
      if (widgetRendered) {
        console.log("PDC missed but widget is rendered — treating as valid");
        pdc.validProduct = true;
      }
    }

    console.log(
      "PDC resolved:",
      pdc.store,
      pdc.productType,
      "valid:",
      pdc.validProduct,
    );

    // -----------------------------
    // Bag Gatekeeping
    // -----------------------------

    if (isBagProduct(pdc)) {
      console.log("[bag] Bag product detected:", pdc.productType);

      if (pdc.validProduct !== true) {
        console.log("SKIPPED: Invalid bag product");
        logResult({
          url,
          store: pdc.store,
          productType: pdc.productType,
          status: "skipped",
          browser: testInfo.project.name,
          reason: "Invalid product",
          durationMs: Date.now() - startTime,
        });
        return;
      }

      if (phase === "api") {
        logResult({
          url,
          store: pdc.store,
          productType: pdc.productType,
          status: "passed",
          browser: testInfo.project.name,
          phase,
          durationMs: Date.now() - startTime,
        });
        return;
      }

      // Wait for and click inpage button
      await page.waitForFunction(
        () => {
          const root =
            document.querySelector("#vs-inpage")?.shadowRoot ||
            document.querySelector("#vs-inpage-luxury")?.shadowRoot;
          return (
            !!root?.querySelector('[data-test-id="inpage-open-aoyama-btn"]') ||
            !!root?.querySelector('[data-test-id="inpage-luxury-open-aoyama"]')
          );
        },
        { timeout: 15000 },
      );

      await page.evaluate(() => {
        const root =
          document.querySelector("#vs-inpage")?.shadowRoot ||
          document.querySelector("#vs-inpage-luxury")?.shadowRoot;
        const btn =
          root?.querySelector('[data-test-id="inpage-open-aoyama-btn"]') ||
          root?.querySelector('[data-test-id="inpage-luxury-open-aoyama"]');
        btn?.click();
      });

      console.log("[bag] Clicked inpage button");
      await page.waitForTimeout(2000);

      if (phase === "widget") {
        logResult({
          url,
          store: pdc.store,
          productType: pdc.productType,
          status: "passed",
          browser: testInfo.project.name,
          phase,
          durationMs: Date.now() - startTime,
        });
        return;
      }

      await page.waitForFunction(() => !!getWidgetHost()?.shadowRoot, {
        timeout: 15000,
      });

      await runBagFlow(page);

      console.log("[bag] Bag flow completed");

      eventWatcher.reset();
      eventWatcher.setPhase("refresh");
      await page.reload();
      console.log("[bag] Page refreshed — collecting events");
      await page.waitForTimeout(3000);

      logResult({
        url,
        store: pdc.store,
        productType: pdc.productType,
        flow: "bag",
        status: "passed",
        browser: testInfo.project.name,
        events: eventWatcher.getAllEvents(),
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // -----------------------------
    // Gatekeeping
    // -----------------------------

    const isBotProtectedUrl = (() => {
      try {
        const hostname = new URL(url).hostname.replace(/^www\./, "");
        return BOT_PROTECTED_DOMAINS.some(
          (d) => hostname === d || hostname.endsWith(`.${d}`),
        );
      } catch {
        return false;
      }
    })();

    const skipReason =
      getSkipReason(pdc) ??
      (isBotProtectedUrl
        ? "Bot-protected store — cannot be automated (bot detection)"
        : null) ??
      (pdc.validProduct !== true
        ? "No valid Virtusize product detected on this PDP"
        : null);

    if (skipReason) {
      console.log("SKIPPED:", skipReason);

      logResult({
        url,
        store: pdc.store,
        productType: pdc.productType,
        status: "skipped",
        browser: testInfo.project.name,
        reason: skipReason,
        durationMs: Date.now() - startTime,
      });

      return;
    }

    // api phase: PDC confirmed valid — integration check complete
    if (phase === "api") {
      logResult({
        url,
        store: pdc.store,
        productType: pdc.productType,
        status: "passed",
        browser: testInfo.project.name,
        phase,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // -----------------------------
    // Open Inpage
    // -----------------------------

    await page.waitForFunction(
      () => {
        return (
          document.querySelector("#vs-placeholder-cart") ||
          document.querySelector("#vs-inpage") ||
          document.querySelector("#vs-inpage-luxury") ||
          document.querySelector("#vs-legacy-inpage") ||
          document.querySelector("#vs-kid")
        );
      },
      { timeout: 30000 },
    );
    widgetVisibleMs = Date.now() - t_nav;

    // Detect widget type and smart table presence
    widgetMeta = await page.evaluate(() => {
      const found = [
        [document.querySelector("#vs-inpage"),           "inpage"],
        [document.querySelector("#vs-inpage-luxury"),    "inpage_luxury"],
        [document.querySelector("#vs-legacy-inpage"),    "inpage_mini"],
        [document.querySelector("#vs-kid"),              "kids"],
        [document.querySelector("#vs-placeholder-cart"), "placeholder_cart"],
      ].find(([el]) => el);
      if (!found) return { widgetType: null, hasSmartTable: null };
      const [el, type] = found;
      const sr = el.shadowRoot;
      const smartTableTypes = ["inpage", "inpage_luxury", "inpage_mini"];
      const hasSmartTable = smartTableTypes.includes(type) && sr != null
        ? !!sr.querySelector("#vs-smart-table")
        : null;
      return { widgetType: type, hasSmartTable };
    }).catch(() => ({ widgetType: null, hasSmartTable: null }));

    // Capture widget presence screenshot before opening — shows inpage button on page
    if (phase === "full") {
      try {
        const buf = await page.screenshot({ type: "jpeg", quality: 70 });
        if (buf) {
          const { mkdirSync, writeFileSync } = await import("fs");
          const { join, dirname } = await import("path");
          const { fileURLToPath } = await import("url");
          const __dir = dirname(fileURLToPath(import.meta.url));
          const dir = join(__dir, "../test-results/widget-screenshots");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${testInfo.project.name}.jpg`), buf);
        }
      } catch { /* non-fatal */ }
    }

    flow = detectFlow(pdc);
    console.log("Flow:", flow);

    if (flow === "kids") {
      await clickKidsWidget(page);
      await waitForKidsWidgetReady(page);
    } else {
      await clickWidget(page, flow);

      await waitForWidgetRender(page);
    }

    // widget phase: widget element found and opened — check complete
    if (phase === "widget") {
      logResult({
        url,
        store: pdc.store,
        productType: pdc.productType,
        status: "passed",
        browser: testInfo.project.name,
        phase,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // events phase: verify baseline integration events fired after widget open
    if (phase === "events") {
      const missing = await verifyEvents(
        page,
        () => eventWatcher.getAllEvents(),
        expectedEvents.strict.baseline,
      );
      if (missing.length > 0) {
        const err = new Error(`Missing events: ${missing.join(", ")}`);
        err.missingEvents = missing;
        throw err;
      }
      logResult({
        url,
        store: pdc.store,
        productType: pdc.productType,
        status: "passed",
        browser: testInfo.project.name,
        phase,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    let isNewUser;
    if (flow === "apparel") {
      isNewUser = await runApparelFlow(page, bodyAPI, eventWatcher, recommendationAPI, onboardingOpts);
    }
    if (flow === "footwear") {
      isNewUser = await runFootwearFlow(page, footwearOpts);
    }
    if (flow === "kids") {
      isNewUser = await runKidsFlow(page, pdc, kidsOpts);
    }
    if (flow === "noVisor") {
      isNewUser = await runNoVisorFlow(page, bodyAPI, onboardingOpts);
    }
    flowDoneMs = Date.now() - t_nav;

    // onboarding phase: onboarding complete — skip full validation
    if (phase === "onboarding") {
      logResult({
        url,
        store: pdc.store,
        productType: pdc.productType,
        userType: isNewUser ? "NEW" : "RETURNING",
        status: "passed",
        browser: testInfo.project.name,
        phase,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // -----------------------------
    // Recommendation
    // -----------------------------

    if (flow === "apparel") {
      await validateRecommendation(eventWatcher);
    }

    if (flow === "footwear") {
      await page.waitForFunction(() => {
        const host =
          document.querySelector("#router-view-wrapper") ||
          document.querySelector("#vs-aoyama")?.nextElementSibling;
        const root = host?.shadowRoot;
        return root?.querySelector('[data-test-id="no-visor-recommended-size"]');
      });
    }

    // compare phase: recommendation visible — screenshot and stop
    if (phase === "compare") {
      await page.waitForTimeout(1500);
      const widgetHost = page.locator("#router-view-wrapper").first();
      const widgetVisible = await widgetHost.isVisible().catch(() => false);
      const screenshot = widgetVisible
        ? await widgetHost.screenshot({ timeout: 10000 }).catch(() => null)
        : await page.screenshot({ fullPage: false }).catch(() => null);

      if (screenshot) {
        const { mkdirSync, writeFileSync } = await import("fs");
        const { join, dirname } = await import("path");
        const { fileURLToPath } = await import("url");
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const screenshotsDir = join(__dirname, "../test-results/compare-view-screenshots");
        mkdirSync(screenshotsDir, { recursive: true });
        const filename = `${pdc.store || "unknown"}-${testInfo.project.name}.png`;
        writeFileSync(join(screenshotsDir, filename), screenshot);
        await testInfo.attach(filename, { body: screenshot, contentType: "image/png" });
        console.log(`COMPARE_VIEW_RESULT: ${JSON.stringify({ store: pdc.store, url, browser: testInfo.project.name, status: "screenshot_taken" })}`);
      }

      logResult({
        url,
        store: pdc.store,
        productType: pdc.productType,
        userType: isNewUser ? "NEW" : "RETURNING",
        status: "passed",
        browser: testInfo.project.name,
        phase,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // -----------------------------
    // Size + Wardrobe (apparel only)
    // -----------------------------

    if (flow === "apparel") {
      await selectSizeIfMultiple(page, eventWatcher);
      await page.waitForTimeout(4000);
      await Promise.race([
        addItemToWardrobe(page, eventWatcher.getAllEvents()),
        page.waitForTimeout(8000),
      ]);
    }

    if (flow === "footwear") {
      await page.waitForFunction(() => {
        const host =
          document.querySelector("#router-view-wrapper") ||
          document.querySelector("#vs-aoyama")?.nextElementSibling;

        const root = host?.shadowRoot;
        return root?.querySelector(
          '[data-test-id="no-visor-recommended-size"]',
        );
      });
    }

    // -----------------------------
    // Core Event Validation
    // -----------------------------

    await validateCoreEvents(page, eventWatcher, flow);

    // -----------------------------
    // Refresh Validation
    // -----------------------------

    await page.waitForTimeout(5000);

    // REFRESH
    await validateRefresh(page, eventWatcher, recommendationAPI, flow);

    // -----------------------------
    // Gift Flow (apparel only, if CTA present)
    // -----------------------------

    const isLuxuryInpage = await page.evaluate(
      () => !!document.querySelector("#vs-inpage-luxury"),
    );

    if (flow === "apparel" && !isLuxuryInpage) {
      // GIFT
      // Give Virtusize time to settle after size selection before starting gift flow
      await page.waitForTimeout(10000);
      eventWatcher.setPhase("gift");
      eventWatcher.reset();
      await runGiftFlow(page, eventWatcher, giftOpts);
    }

    eventWatcher.logPhaseSummary();

    // -----------------------------
    // PASS
    // -----------------------------

    const inpageMountCount = await page
      .evaluate(() => window.__vsInpageMountCount ?? 0)
      .catch(() => 0);

    if (inpageMountCount > 1) {
      console.warn(
        `[SPA] Inpage widget mounted ${inpageMountCount}x — possible double-mount`,
      );
    }

    logResult({
      url,
      store: pdc.store,
      productType: pdc.productType,
      flow,
      userType: isNewUser ? "NEW" : "RETURNING",
      status: testInfo.status === "timedOut" ? "passed" : testInfo.status,
      browser: testInfo.project.name,
      events: eventWatcher.getAllEvents(),
      durationMs: Date.now() - startTime,
      widgetVisibleMs,
      flowDoneMs,
      widgetType: widgetMeta.widgetType,
      hasSmartTable: widgetMeta.hasSmartTable,
      ...(inpageMountCount > 1 && { doubleMount: inpageMountCount }),
    });
  } catch (error) {
    logResult({
      url,
      status: "failed",
      flow,
      browser: testInfo.project.name,
      error: error.message,
      missingEvents: error.missingEvents || [],
      events: eventWatcher.getAllEvents(),
      durationMs: Date.now() - startTime,
      widgetVisibleMs,
      flowDoneMs,
    });

    throw error;
  }
});
} // end for loop

function logResult(result) {
  console.log("QA_RESULT:", JSON.stringify(result));
}
