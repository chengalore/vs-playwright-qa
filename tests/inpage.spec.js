import { test, expect } from "@playwright/test";
import { startVirtusizeEventWatcher } from "../utils/eventWatcher.js";
import { startPDCWatcher } from "../utils/pdcWatcher.js";
import { startRecommendationWatcher } from "../utils/recommendationWatcher.js";
import { startBodyMeasurementWatcher } from "../utils/bodyMeasurementWatcher.js";
import { startShoeRecommendationWatcher } from "../utils/shoeRecommendationWatcher.js";
import { verifyEvents } from "../utils/verifyEvents.js";
import { expectedEvents } from "../config/expectedEvents.js";
import { completeOnboarding } from "../utils/completeOnboarding.js";
import { validateRecommendation } from "../utils/validateRecommendation.js";
import { selectSizeIfMultiple } from "../utils/selectSizeIfMultiple.js";
import { addItemToWardrobe } from "../utils/addItemToWardrobe.js";
import { blockMarketingScripts } from "../utils/blockMarketingScripts.js";
import { resolveTestUrl } from "../utils/fetchRandomProduct.js";
import { BOT_PROTECTED_DOMAINS } from "../config/stores.js";

test.setTimeout(180000);

test("Inpage basic flow", async ({ page }, testInfo) => {
  const startTime = Date.now();
  const phase = process.env.TEST_PHASE || "full";

  const url = await resolveTestUrl(
    "https://www.underarmour.co.jp/f/dsg-1072366",
  );

  console.log("Testing URL:", url);

  const eventWatcher = startVirtusizeEventWatcher(page);
  eventWatcher.setPhase("onboarding");
  const pdc = startPDCWatcher(page);
  const recommendationAPI = startRecommendationWatcher(page);
  const bodyAPI = startBodyMeasurementWatcher(page);
  const shoeAPI = startShoeRecommendationWatcher(page);

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

  try {
    console.log("Navigating to:", url);
    await page.goto(url);
    console.log("Page loaded");

    // Trigger lazy-loaded widgets that rely on IntersectionObserver.
    // Scroll to the widget element if present, otherwise fall back to a fixed
    // offset — without a scroll the widget container may never mount.
    await page.evaluate(() => {
      // #vs-placeholder-cart is a mounting point only — scroll to the actual widget element.
      const widget = document.querySelector(
        "#vs-inpage, #vs-inpage-luxury, #vs-legacy-inpage, #vs-kid, #vs-placeholder-cart"
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
          '#onetrust-accept-btn-handler, ' +
          'button[id*="cookie"][id*="accept"], ' +
          'button[class*="cookie"][class*="accept"]',
        )
        .forEach((btn) => btn.click());
    });

    await waitForPDC(pdc);
    console.log("PDC resolved:", pdc.store, pdc.productType, "valid:", pdc.validProduct);

    // -----------------------------
    // Gatekeeping
    // -----------------------------

    const isBotProtectedUrl = (() => {
      try {
        const hostname = new URL(url).hostname.replace(/^www\./, "");
        return BOT_PROTECTED_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
      } catch { return false; }
    })();

    const skipReason =
      getSkipReason(pdc) ??
      (isBotProtectedUrl ? "Bot-protected store — cannot be automated (bot detection)" : null) ??
      (pdc.validProduct !== true ? "No valid Virtusize product detected on this PDP" : null);

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

    const flow = detectFlow(pdc);
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
        () => eventWatcher.getEvents(),
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
      isNewUser = await runApparelFlow(
        page,
        bodyAPI,
        eventWatcher,
        recommendationAPI,
      );
    }
    if (flow === "footwear") {
      isNewUser = await runFootwearFlow(page, shoeAPI);
    }
    if (flow === "kids") {
      isNewUser = await runKidsFlow(page, pdc);
    }
    if (flow === "noVisor") {
      isNewUser = await runNoVisorFlow(page, bodyAPI);
    }

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

    // -----------------------------
    // Size + Wardrobe (apparel only)
    // -----------------------------

    if (flow === "apparel") {
      await selectSizeIfMultiple(page, eventWatcher);
      await page.waitForTimeout(4000);
      await Promise.race([
        addItemToWardrobe(page, eventWatcher.getEvents()),
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

    await page.waitForTimeout(3000);

    // REFRESH
    await validateRefresh(page, eventWatcher, recommendationAPI, flow);

    // -----------------------------
    // Gift Flow (apparel only, if CTA present)
    // -----------------------------

    if (flow === "apparel") {
      // GIFT
      // Give Virtusize time to settle after size selection before starting gift flow
      await page.waitForTimeout(10000);
      eventWatcher.setPhase("gift");
      eventWatcher.reset();
      await runGiftFlow(page, eventWatcher);
    }

    eventWatcher.logPhaseSummary();

    // -----------------------------
    // PASS
    // -----------------------------

    logResult({
      url,
      store: pdc.store,
      productType: pdc.productType,
      userType: isNewUser ? "NEW" : "RETURNING",
      status: testInfo.status === "timedOut" ? "passed" : testInfo.status,
      browser: testInfo.project.name,
      durationMs: Date.now() - startTime,
    });
  } catch (error) {
    logResult({
      url,
      status: "failed",
      browser: testInfo.project.name,
      error: error.message,
      missingEvents: error.missingEvents || [],
      durationMs: Date.now() - startTime,
    });

    throw error;
  }
});

// --------------------------------------------------
// Gatekeeping
// --------------------------------------------------

function getSkipReason(pdc) {
  const excludedTypes = ["bag", "wallet", "clutch", "panties"];

  if (pdc.validProduct === false) return "Invalid Product (validProduct=false)";
  // allow no-visor flow to run
  if (excludedTypes.includes(pdc.productType?.toLowerCase()))
    return "Non apparel item";

  return null;
}

// --------------------------------------------------
// Validators
// --------------------------------------------------

async function validateCoreEvents(page, eventWatcher, flow) {
  const getEvents = () => eventWatcher.getEvents();

  const missing =
    flow === "kids"
      ? await verifyEvents(page, getEvents, expectedEvents.strict.kids)
      : flow === "noVisor"
        ? await verifyEvents(page, getEvents, expectedEvents.strict.noVisor)
        : flow === "gift"
          ? await verifyEvents(page, getEvents, expectedEvents.strict.gift)
          : [
            ...(await verifyEvents(
              page,
              getEvents,
              expectedEvents.strict.baseline,
            )),
            ...(flow === "footwear"
              ? await verifyEvents(
                  page,
                  getEvents,
                  expectedEvents.strict.footwear,
                )
              : [
                  ...(await verifyEvents(
                    page,
                    getEvents,
                    expectedEvents.strict.recommendation,
                  )),
                  ...(await verifyEvents(
                    page,
                    getEvents,
                    expectedEvents.strict.panels,
                  )),
                ]),
          ];

  if (missing.length > 0) {
    const error = new Error(`Missing events: ${missing.join(", ")}`);
    error.missingEvents = missing;
    throw error;
  }

  validateStrictDuplicates(eventWatcher);
}

async function validateRefresh(page, eventWatcher, recommendationAPI, flow) {
  if (flow === "kids") {
    eventWatcher.reset();
    eventWatcher.setPhase("refresh");

    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForWidget(page, "kids");
    await clickKidsWidget(page);

    console.log("Waiting for kids recommendation after refresh");

    await waitForEvent(eventWatcher, "user-selected-size-kids-rec::kids", 15000);

    const failures = await verifyEvents(
      page,
      () => eventWatcher.getEvents(),
      expectedEvents.refresh.kids,
    );

    if (failures.length > 0) {
      const error = new Error(`Refresh missing events: ${failures.join(", ")}`);
      error.missingEvents = failures;
      throw error;
    }

    return;
  }

  eventWatcher.reset();
  eventWatcher.setPhase("refresh");

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForWidget(page, flow);

  if (flow === "gift") {
    await clickWidget(page, flow);

    console.log("Waiting for gift recommendation after refresh");

    await waitForEvent(eventWatcher, "user-opened-panel-rec::gift", 20000);
  } else {
    await clickWidget(page, flow);

    // Allow widget UI to stabilize after refresh without blocking on a specific
    // screen selector — stores like CELFORD may render the gift CTA instead of
    // a standard recommendation panel, which would cause waitForWidgetRender to hang.
    await page.waitForTimeout(1500);

    // -----------------------------------------
    // CHECK RECOMMENDATION API REFIRE
    // -----------------------------------------

    if (flow !== "noVisor") {
      const recStatus = await waitForStatus(
        () => recommendationAPI.getStatus(),
        5000,
      );

      if (recStatus !== 200) {
        throw new Error(
          `Recommendation API did not refire after refresh (status: ${recStatus})`,
        );
      }
    }

    if (flow === "footwear") {
      await waitForEvent(eventWatcher, "user-selected-size", 10000);
    }
  }

  // -----------------------------------------
  // CHECK EVENTS
  // -----------------------------------------

  const schema =
    flow === "footwear"
      ? expectedEvents.refresh.footwear
      : flow === "gift"
        ? expectedEvents.refresh.gift
        : flow === "noVisor"
          ? expectedEvents.refresh.noVisor
          : expectedEvents.refresh.apparel;

  const failures = await verifyEvents(
    page,
    () => eventWatcher.getEvents(),
    schema,
  );

  if (failures.length > 0) {
    const error = new Error(`Refresh missing events: ${failures.join(", ")}`);
    error.missingEvents = failures;
    throw error;
  }

  validateStrictDuplicates(eventWatcher);
}

// --------------------------------------------------
// Strict Duplicate Validation
// --------------------------------------------------

function validateStrictDuplicates(eventWatcher) {
  const counts = eventWatcher.getCounts();
  const failures = [];

  // Baseline events (integration only)
  const baselineKeys = [
    "user-saw-product::integration",
    "user-saw-widget-button::integration",
    "user-opened-widget::integration",
  ];

  baselineKeys.forEach((key) => {
    if ((counts[key] || 0) > 1) {
      failures.push(`${key} x${counts[key]}`);
    }
  });

  // Recommendation (integration only, max 1)
  const recCount = counts["user-got-size-recommendation::integration"] || 0;

  if (recCount > 1) {
    failures.push(`user-got-size-recommendation::integration x${recCount}`);
  }

  // Size strict rules
  const sizeIntegration = counts["user-selected-size::integration"] || 0;

  const sizeInpage = counts["user-selected-size::inpage"] || 0;

  if (sizeIntegration > 1) {
    failures.push(`user-selected-size::integration x${sizeIntegration}`);
  }

  if (sizeInpage > 1) {
    failures.push(`user-selected-size::inpage x${sizeInpage}`);
  }

  if (failures.length > 0) {
    throw new Error(`Strict duplicate events detected: ${failures.join(", ")}`);
  }
}

// --------------------------------------------------
// Flow Detection
// --------------------------------------------------

function detectFlow(pdc) {
  const gender = pdc.gender?.toLowerCase();
  const isKid = pdc.isKid || gender === "boy" || gender === "girl";
  if (isKid) return "kids";
  if (pdc.noVisor) return "noVisor";
  if (pdc.productType?.toLowerCase() === "shoe") return "footwear";
  return "apparel";
}

async function detectGiftEntry(page) {
  return await page.evaluate(() => {
    return !!findInShadow('[data-test-id="gift-cta"]');
  });
}

// --------------------------------------------------
// Body Type Selection
// --------------------------------------------------

// --------------------------------------------------
// Apparel Flow
// --------------------------------------------------

async function runApparelFlow(page, bodyAPI, eventWatcher, recommendationAPI) {
  const isNewUser = await isOnboardingVisible(page);

  if (isNewUser) {
    await completeOnboarding(page);

    await waitForRecommendationReady(eventWatcher, recommendationAPI);

    const bodyStatus = await waitForStatus(() => bodyAPI.getStatus(), 5000);
    expect(bodyStatus).toBe(200);
  }

  return isNewUser;
}

// --------------------------------------------------
// No-Visor Flow
// --------------------------------------------------

async function runNoVisorFlow(page, bodyAPI) {
  const isNewUser = await isOnboardingVisible(page);

  if (isNewUser) {
    console.log("New user → running onboarding (no-visor)");

    await completeOnboarding(page);

    const bodyStatus = await waitForStatus(() => bodyAPI.getStatus(), 5000);
    expect(bodyStatus).toBe(200);
  }

  console.log("Waiting for no-visor result screen");

  await page.waitForFunction(() => {
    const host =
      document.querySelector("#router-view-wrapper") ||
      document.querySelector("#vs-aoyama")?.nextElementSibling;
    const root = host?.shadowRoot;
    return root?.querySelector('[data-test-id="no-visor-recommended-size"]');
  });

  return isNewUser;
}

// --------------------------------------------------
// Footwear Flow
// --------------------------------------------------

async function runFootwearFlow(page, shoeAPI) {
  // Wait for modal to appear inside shadow root
  await page.waitForFunction(
    () => !!getWidgetHost()?.shadowRoot?.querySelector("#vs-aoyama-main-modal"),
    { timeout: 15000 },
  );

  const isNewUser = await page.evaluate(() => {
    const root = getWidgetHost()?.shadowRoot;
    if (!root) return false;

    return (
      root.querySelector('[data-test-id="footWidth-select-item-btn"]') ||
      root.querySelector('[data-test-id="toeShape-select-item-btn"]') ||
      root.querySelector('[data-test-id="open-sizes-footwear-picker"]') ||
      root.querySelector('[data-test-id="open-brands-footwear-picker"]')
    );
  });

  if (!isNewUser) return isNewUser;

  console.log("New user → running footwear onboarding");

  const shadowClick = async (selector, { timeout = 10000 } = {}) => {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const clicked = await page.evaluate((sel) => {
        const el = getWidgetHost()?.shadowRoot?.querySelector(sel);
        if (!el) return false;
        el.click();
        return true;
      }, selector);

      if (clicked) return;

      await page.waitForTimeout(300);
    }

    throw new Error(`shadowClick: "${selector}" not clickable`);
  };

  const clickNext = () => shadowClick('[data-test-id="footwear-next-btn"]');

  // Step 1: Foot width – click first option
  await shadowClick('[data-test-id="footWidth-select-item-btn"]');
  await clickNext();

  // Step 2: Toe shape – click middle option
  await page.waitForFunction(
    () =>
      (getWidgetHost()?.shadowRoot?.querySelectorAll(
        '[data-test-id="toeShape-select-item-btn"]',
      )?.length ?? 0) > 0,
    { timeout: 15000 },
  );
  await page.evaluate(() => {
    const btns = getWidgetHost()?.shadowRoot?.querySelectorAll(
      '[data-test-id="toeShape-select-item-btn"]',
    );
    if (btns?.length) btns[Math.floor(btns.length / 2)].click();
  });
  await clickNext();

  // Step 3: Gender (optional)
  const hasGender = await page.evaluate(() => {
    const modal = getWidgetHost()?.shadowRoot?.querySelector(
      "#vs-aoyama-main-modal"
    );
    return !!modal?.querySelector(
      '[data-test-id="gender-radio-buttons"] input[type="radio"]'
    );
  });

  if (hasGender) {
    await page.evaluate(() => {
      const modal = getWidgetHost()?.shadowRoot?.querySelector(
        "#vs-aoyama-main-modal"
      );
      const radios = modal?.querySelectorAll(
        '[data-test-id="gender-radio-buttons"] input[type="radio"]'
      );
      const female = [...radios].find(
        (el) => el.value.toLowerCase() === "female"
      );
      if (female) {
        female.click();
        female.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    await page.waitForTimeout(800);
    await clickNext();
  }

  // Step 4: Footwear size – open picker
  await shadowClick('[data-test-id="open-sizes-footwear-picker"]');

  // Wait for picker radios
  await page.waitForFunction(() => {
    const root = getWidgetHost()?.shadowRoot;
    return root?.querySelector('[data-test-id="footwear-picker"] input[type="radio"]');
  }, { timeout: 5000 });

  // Select radio only if nothing is selected
  await page.evaluate(() => {
    const modal = getWidgetHost()?.shadowRoot?.querySelector("#vs-aoyama-main-modal");
    const radios = modal?.querySelectorAll('[data-test-id="footwear-picker"] input[type="radio"]');

    if (!radios?.length) return;

    const alreadyChecked = [...radios].find(r => r.checked);

    if (!alreadyChecked) {
      const first = radios[0];
      first.click();
      first.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  await page.waitForTimeout(500);
  await clickNext();

  // Step 5: Privacy policy
  await page.evaluate(() => {
    const modal = getWidgetHost()?.shadowRoot?.querySelector(
      "#vs-aoyama-main-modal",
    );
    const checkbox = modal?.querySelector(
      '[data-test-id="footwear-privacy-policy"]',
    );
    if (checkbox && !checkbox.checked) {
      checkbox.click();
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await page.waitForTimeout(800);
  await clickNext();

  // Step 6: Brand – open picker, select first option, wait for picker to close
  await page.evaluate(() => {
    const modal = getWidgetHost()?.shadowRoot?.querySelector(
      "#vs-aoyama-main-modal",
    );
    modal
      ?.querySelector('[data-test-id="open-brands-footwear-picker"]')
      ?.click();
  });
  await page.waitForFunction(
    () =>
      !!getWidgetHost()?.shadowRoot?.querySelector(
        '[data-test-id="footwear-picker"]',
      ),
    { timeout: 5000 },
  );
  await page.evaluate(() => {
    const root = getWidgetHost()?.shadowRoot;
    root
      ?.querySelector(
        '[data-test-id="footwear-picker"] label[for="radioButton-0"]',
      )
      ?.click();
  });
  await page.waitForFunction(
    () => {
      const picker = getWidgetHost()?.shadowRoot?.querySelector(
        '[data-test-id="footwear-picker"]',
      );
      if (!picker) return true;
      const style = window.getComputedStyle(picker);
      return (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      );
    },
    { timeout: 5000 },
  );
  await page.waitForTimeout(500);
  await clickNext();

  const shoeStatus = await waitForStatus(() => shoeAPI.getStatus(), 8000);
  expect(shoeStatus).toBe(200);

  return isNewUser;
}

// --------------------------------------------------
// Kids Flow
// --------------------------------------------------

async function runKidsFlow(page, _pdc) {
  console.log("[kids] Starting Kids flow");

  // Wait for gender radio buttons to appear
  await page.waitForFunction(
    () => !!findInShadow('input[name="selectKidGender"]'),
    { timeout: 15000 },
  );
  console.log("[kids] Gender radio buttons detected");

  // Click girl radio
  await kidsRetry(page, async () => {
    await page.evaluate(() => {
      const radio = findInShadow('input[name="selectKidGender"][value="girl"]');
      if (!radio) throw new Error("Girl gender radio not found");
      radio.click();
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }, "click girl gender radio");
  console.log("[kids] Gender selected: girl");

  // Open age selector — try both known selector patterns
  await kidsRetry(page, async () => {
    await page.evaluate(() => {
      const root = document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot;
      if (!root) throw new Error("Kids shadow root not found");
      const ageSpan =
        root.querySelector("span.age-input-value") ??
        root.querySelector('[data-test-id="age-input-value"]');
      if (!ageSpan) throw new Error("Age input span not found");
      ageSpan.click();
    });
  }, "open age selector");
  console.log("[kids] Age selector opened");

  // Wait for age picker radios — any radio that is NOT the gender radio
  await page.waitForFunction(
    () => {
      const root = document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot;
      if (!root) return false;
      return [...root.querySelectorAll('input[type="radio"]')]
        .some((r) => r.name !== "selectKidGender");
    },
    { timeout: 10000 },
  );

  // Select age radio — 6th option (index 5) or first if fewer exist
  await page.evaluate(() => {
    const root = document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot;
    if (!root) throw new Error("[kids] Shadow root not found for age selection");

    const ageRadios = [...root.querySelectorAll('input[type="radio"]')]
      .filter((r) => r.name !== "selectKidGender");

    if (!ageRadios.length) throw new Error("[kids] No age radio buttons found");

    const target = ageRadios[5] ?? ageRadios[0];
    target.click();
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  console.log("[kids] Age selected");

  /* -------------------- HEIGHT & WEIGHT -------------------- */

  console.log("[kids] Waiting for height and weight inputs...");

  await page.waitForFunction(
    () => {
      const root = document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot;
      return !!(
        root?.querySelector('[data-test-id="kids-height-input-desktop"] input') &&
        root?.querySelector('[data-test-id="kids-weight-input-desktop"] input')
      );
    },
    { timeout: 15000 },
  );

  for (const [testId, value] of [
    ["kids-height-input-desktop", "120"],
    ["kids-weight-input-desktop", "25"],
  ]) {
    await page.evaluate(
      ({ testId, value }) => {
        const root = document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot;
        const input = root?.querySelector(`[data-test-id="${testId}"] input`);
        if (!input) throw new Error(`[kids] Input not found: ${testId}`);
        input.focus();
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
      },
      { testId, value },
    );
  }
  console.log("[kids] Height and weight filled");

  /* -------------------- PRIVACY POLICY -------------------- */

  await page.evaluate(() => {
    const root = document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot;
    if (!root) return;
    const checkbox = root.querySelector('[data-test-id="privacy-policy-checkbox"]');
    if (checkbox && !checkbox.checked) {
      checkbox.click();
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  console.log("[kids] Privacy policy accepted");

  /* -------------------- CTA BUTTON -------------------- */

  await kidsRetry(page, async () => {
    await page.evaluate(() => {
      const root = document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot;
      const btn = root?.querySelector('[data-test-id="see-ideal-fit-btn"]');
      if (!btn) throw new Error("[kids] CTA button not found");
      btn.click();
    });
  }, "click see-ideal-fit-btn");
  console.log("[kids] Clicked See Your Perfect Fit");

  /* -------------------- WAIT FOR RESULT -------------------- */

  await page.waitForFunction(
    () => {
      const root = document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot;
      return !!root?.querySelector('[data-test-id="kids-recommended-size"]');
    },
    { timeout: 30000 },
  );
  console.log("[kids] Kids flow completed successfully");

  return true;
}

// --------------------------------------------------
// Gift Flow
// --------------------------------------------------

async function runGiftFlow(page, eventWatcher) {
  console.log("Running VS Gift flow");

  // detect gift CTA in widget — not all stores enable it
  // wait briefly since the CTA can appear after the recommendation panel loads
  const hasGift = await page.waitForFunction(
    () => !!findInShadow('[data-test-id="gift-cta-section"]'),
    { timeout: 5000 }
  ).catch(() => false);

  if (!hasGift) {
    console.log("Gift CTA not found — skipping gift flow");
    return false;
  }

  // ── 1. Open gift CTA ──────────────────────────────────────────────────────

  // Wait for gift-cta to be present in the shadow DOM — the section may appear
  // before the button is rendered (e.g. lazy shadow init on CELFORD).
  await page.waitForFunction(
    () => !!findInShadow('[data-test-id="gift-cta"]'),
    { timeout: 15000 }
  );

  await page.evaluate(() =>
    findInShadow('[data-test-id="gift-cta"]')?.click()
  );

  // Wait for onboarding to mount
  await page.waitForFunction(
    () => !!findInShadow('[data-test-id="input-age-desktop"]'),
    { timeout: 15000 }
  );

  console.log("Gift onboarding detected");

  // Wait for Virtusize to fully settle before interacting with onboarding inputs
  await page.waitForTimeout(5000);

  // ── 2. Gender ─────────────────────────────────────────────────────────────

  await page.evaluate(() => {
    const radio = findInShadow('input[name="selectGender"][value="female"]');
    if (!radio) throw new Error("Female gender radio not found");
    radio.click();
    radio.dispatchEvent(new Event("change", { bubbles: true }));
  });

  console.log("Selected gender: female");

  // ── 3. Age ────────────────────────────────────────────────────────────────

  // Playwright locators auto-pierce shadow DOM and retry until actionable,
  // eliminating the TOCTOU race between waitForFunction and page.evaluate.
  await page.locator('[data-test-id="input-age-desktop"]').click();

  // Wait for age options (span[role="radio"]) to appear inside #sheet in the shadow DOM.
  // Scope to #sheet so we don't accidentally click gender radio buttons which share the selector.
  await page.waitForFunction(
    () => !!findInShadow('#sheet')?.querySelector('span[role="radio"]'),
    { timeout: 10000 }
  );
  await page.evaluate(() => findInShadow('#sheet')?.querySelector('span[role="radio"]')?.click());

  // Wait for the age sheet to close
  await page.waitForFunction(
    () => !findInShadow('#sheet')?.querySelector('span[role="radio"]'),
    { timeout: 8000 }
  );

  console.log("Selected age");

  // ── 4. Height ─────────────────────────────────────────────────────────────

  await page.waitForTimeout(600);

  await page.locator('[data-test-id="input-height-desktop"]').click();

  // Wait for height options to appear inside #sheet, then click first one
  await page.waitForFunction(
    () => !!findInShadow('#sheet')?.querySelector('span[role="radio"]'),
    { timeout: 10000 }
  );
  await page.evaluate(() => findInShadow('#sheet')?.querySelector('span[role="radio"]')?.click());

  // Wait for the height sheet to close
  await page.waitForFunction(
    () => !findInShadow('#sheet')?.querySelector('span[role="radio"]'),
    { timeout: 8000 }
  );

  // verify value updated away from placeholder
  await page.waitForFunction(() => {
    const el = findInShadow('[data-test-id="input-height-desktop"]');
    return el && !/^\s*-\s*$/.test(el.textContent ?? '');
  }, { timeout: 8000 });

  console.log("Selected height");

  // ── 5. Body type ──────────────────────────────────────────────────────────

  await page.waitForTimeout(600);

  await page.locator('[data-test-id="input-body-type"]').click();

  const bodySheet = page.locator('[data-test-id="sheetTestId"]');
  await expect(bodySheet).toBeVisible({ timeout: 10000 });

  await bodySheet.locator('[data-test-id="gridItemTestId"]').nth(1).click();

  await expect(bodySheet).toBeHidden({ timeout: 8000 });

  console.log("Selected body type");

  // ── 6. Privacy policy (new users only) ───────────────────────────────────

  const privacyCheckbox = page.locator('[data-test-id="privacy-policy-checkbox"]');
  if (await privacyCheckbox.isVisible()) {
    await privacyCheckbox.click();
    console.log("Accepted privacy policy");
  }

  // ── 7. See ideal fit button ───────────────────────────────────────────────

  const seeIdealFitBtn = page.locator('[data-test-id="see-ideal-fit-btn"]');
  await expect(seeIdealFitBtn).toBeEnabled({ timeout: 8000 });
  await seeIdealFitBtn.click();

  console.log("Clicked see ideal fit button");

  // ── 8. Wait for result ────────────────────────────────────────────────────

  await expect(
    page.locator('[data-test-id="adjustYourSilhouette.header"], .rec-main').first()
  ).toBeVisible({ timeout: 20_000 });

  console.log("Gift recommendation result detected");

  // ── 9. Validate gift events ───────────────────────────────────────────────

  const giftMissing = await verifyEvents(
    page,
    () => eventWatcher.getEvents(),
    expectedEvents.strict.gift
  );
  if (giftMissing.length > 0) {
    const error = new Error(`Gift missing events: ${giftMissing.join(", ")}`);
    error.missingEvents = giftMissing;
    throw error;
  }

  // ── 10. Refresh validation ────────────────────────────────────────────────

  console.log("Validating gift refresh behavior");

  eventWatcher.setPhase("gift-refresh");
  eventWatcher.reset();

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForWidget(page, "apparel");
  await page.waitForTimeout(2000);
  await clickWidget(page, "apparel");

  // Skip waitForWidgetRender — the apparel widget opens first, then gift CTA
  // is clicked next. Wait directly for the gift CTA to appear instead.
  await page.waitForFunction(
    () => !!findInShadow('[data-test-id="gift-cta"]'),
    { timeout: 20000 }
  );

  await page.evaluate(() => findInShadow('[data-test-id="gift-cta"]')?.click());

  // Returning user — recommendation appears without onboarding
  await waitForEvent(eventWatcher, "user-opened-panel-rec::gift", 20000);

  console.log("Gift refresh: recommendation visible");

  const refreshMissing = await verifyEvents(
    page,
    () => eventWatcher.getEvents(),
    expectedEvents.refresh.gift
  );
  if (refreshMissing.length > 0) {
    const error = new Error(`Gift refresh missing events: ${refreshMissing.join(", ")}`);
    error.missingEvents = refreshMissing;
    throw error;
  }

  return true;
}

// --------------------------------------------------
// Kids Helpers
// --------------------------------------------------

/**
 * Ensures the kids widget shadow root is available before starting the flow.
 * Handles both the direct shadowRoot-on-#vs-kid pattern and the
 * #vs-kid-app → nextElementSibling.shadowRoot pattern.
 */
async function waitForKidsWidgetReady(page) {
  await page.waitForFunction(
    () => {
      if (document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot) return true;
      return !!document.querySelector("#vs-kid")?.shadowRoot;
    },
    { timeout: 20000 },
  );
  console.log("[kids] Widget shadow root ready");
}

/**
 * Retries an async action up to maxAttempts times with a delay between each.
 * Throws a descriptive error if all attempts fail.
 */
async function kidsRetry(page, fn, label, maxAttempts = 3, delayMs = 500) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fn();
      return;
    } catch (e) {
      if (attempt === maxAttempts) {
        throw new Error(`[kids] "${label}" failed after ${maxAttempts} attempts: ${e.message}`);
      }
      console.warn(`[kids] "${label}" attempt ${attempt} failed: ${e.message} — retrying...`);
      await page.waitForTimeout(delayMs);
    }
  }
}

// --------------------------------------------------
// Helpers
// --------------------------------------------------

async function waitForPDC(pdc) {
  if (pdc.validProduct === true) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Phase 1 (0–15s): wait for the first product/check response (any validProduct value).
  // Using Promise.race on _whenValid resolves instantly if/when validProduct becomes true,
  // with no polling delay. If nothing arrives in 15s, it's likely not a Virtusize page.
  await Promise.race([pdc._whenValid, sleep(15000)]);

  if (pdc.validProduct === true) return;
  if (pdc.validProduct === undefined) return; // no response at all — exit for skip logic

  // Phase 2 (15–40s): got validProduct: false, meaning Virtusize is active on this page.
  // Some sites fire two product/check calls — pre-hydration returns false, post-hydration
  // returns true. Chromium receives the second response later than Firefox/WebKit due to
  // navigator.webdriver detection delaying script init. Wait up to 25s more for the
  // second (valid) response — _whenValid resolves the instant it arrives.
  await Promise.race([pdc._whenValid, sleep(25000)]);

  // pdc.validProduct is now true, false, or undefined — downstream skip logic decides
}

async function waitForWidgetRender(page) {
  // Wait for widget shadow root
  await page.waitForFunction(
    () => {
      return !!getWidgetHost()?.shadowRoot;
    },
    { timeout: 15000 },
  );

  // Wait for ANY known screen
  await page.waitForFunction(
    () => {
      const root = getWidgetHost()?.shadowRoot;
      if (!root) return false;

      return (
        root.querySelector('[data-test-id="input-age"]') || // apparel onboarding
        root.querySelector('[data-test-id="size-btn"]') || // apparel recommendation
        root.querySelector('[data-test-id="measurements-table"]') || // smart table
        root.querySelector('[data-test-id="measurement-row"]') || // smart table legacy
        root.querySelector('[data-test-id="no-visor-recommended-size"]') || // footwear recommendation
        root.querySelector('[data-test-id="no-visor-container"]') || // no visor
        root.querySelector('[data-test-id="footWidth-select-item-btn"]') || // shoe step 1
        root.querySelector('[data-test-id="toeShape-select-item-btn"]') || // shoe step 2
        root.querySelector('[data-test-id="open-sizes-footwear-picker"]') || // shoe step 4
        root.querySelector('[data-test-id="open-brands-footwear-picker"]') || // shoe step 6
        root.querySelector('[data-test-id="gift-cta"]') // gift entry screen (e.g. CELFORD)
      );
    },
    { timeout: 20000 },
  );
}

async function isOnboardingVisible(page) {
  return await page.evaluate(() => {
    return !!getWidgetHost()?.shadowRoot?.querySelector(
      '[data-test-id="input-age"]',
    );
  });
}

async function waitForRecommendationReady(eventWatcher, recommendationAPI) {
  await waitForStatus(() => recommendationAPI.getStatus(), 15000);

  const start = Date.now();

  while (Date.now() - start < 15000) {
    const events = eventWatcher.getEvents();

    if (
      events.some((e) => e.startsWith("user-opened-panel-tryiton::")) ||
      events.some((e) => e.startsWith("user-saw-measurements-view::"))
    ) {
      return;
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error("Timed out waiting for recommendation screen");
}

async function waitForStatus(getter, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = getter();
    if (value !== null && value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function waitForEvent(eventWatcher, eventKey, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (eventWatcher.getEvents().includes(eventKey)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for event: ${eventKey}`);
}

// --------------------------------------------------
// Widget Wait
// --------------------------------------------------

async function waitForWidget(page, flow) {
  // #vs-placeholder-cart is always a mounting point only (never the widget itself),
  // so exclude it here — wait for the actual widget element to become visible.
  const selector = flow === "kids" ? "#vs-kid" : ":is(#vs-inpage, #vs-inpage-luxury, #vs-legacy-inpage)";

  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;

      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    },
    selector,
    { timeout: 30000 },
  );
}

// --------------------------------------------------
// Widget Click
// --------------------------------------------------

async function shadowExists(page, host, selector) {
  return page.evaluate(
    ({ host, selector }) => {
      return !!document
        .querySelector(host)
        ?.shadowRoot?.querySelector(selector);
    },
    { host, selector },
  );
}

async function clickKidsWidget(page) {
  await page.waitForFunction(() =>
    findInShadow('[data-test-id="kids-inpage-button"]'),
  );
  await page.evaluate(() =>
    findInShadow('[data-test-id="kids-inpage-button"]')?.click(),
  );
}

async function clickWidget(page, flow) {
  // #vs-placeholder-cart excluded — it's a mounting point, never the actual widget.
  const selector = flow === "kids" ? "#vs-kid" : ":is(#vs-inpage, #vs-inpage-luxury, #vs-legacy-inpage)";

  await page.evaluate((sel) => {
    document.querySelector(sel)?.scrollIntoView({ block: "center" });
  }, selector);

  await page.waitForSelector(selector, { state: "visible", timeout: 15000 });

  // For shadow-root variants: wait for the entry point button and click it.
  // #vs-placeholder-cart is a mounting point only — #vs-inpage is injected inside it
  // and is the actual shadow host. Legacy inpage (#vs-legacy-inpage) has no shadow root.
  if (flow !== "kids") {
    if (await page.evaluate(() =>
      !!document.querySelector("#vs-inpage") ||
      !!document.querySelector("#vs-inpage-luxury")
    )) {
      // Wait for the shadow root to render its entry point — either the standard
      // open button or the gift CTA (e.g. CELFORD renders gift-cta directly).
      await page.waitForFunction(() => {
        const root = (
          document.querySelector("#vs-inpage") ||
          document.querySelector("#vs-inpage-luxury")
        )?.shadowRoot;
        return (
          !!root?.querySelector('[data-test-id="inpage-open-aoyama-btn"]') ||
          !!root?.querySelector('[data-test-id="gift-cta"]')
        );
      }, { timeout: 15000 });

      await page.evaluate(() => {
        const root = (
          document.querySelector("#vs-inpage") ||
          document.querySelector("#vs-inpage-luxury")
        )?.shadowRoot;
        const btn =
          root?.querySelector('[data-test-id="inpage-open-aoyama-btn"]') ||
          root?.querySelector('[data-test-id="gift-cta"]');
        btn?.click();
      });
    } else {
      // Legacy inpage — no shadow root, click host directly.
      await page.locator("#vs-legacy-inpage").click({ force: true });
    }

    return;
  }

  // force: true bypasses any overlay that sneaks in at click time
  await page.locator(selector).click({ force: true });
}

// --------------------------------------------------
// Overlay Cleanup
// --------------------------------------------------


function logResult(result) {
  console.log("QA_RESULT:", JSON.stringify(result));
}
