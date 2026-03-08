import { test, expect } from "@playwright/test";
import { startVirtusizeEventWatcher } from "../utils/eventWatcher.js";
import { startPDCWatcher } from "../utils/pdcWatcher.js";
import { startRecommendationWatcher } from "../utils/recommendationWatcher.js";
import { startBodyMeasurementWatcher } from "../utils/bodyMeasurementWatcher.js";
import { verifyEvents } from "../utils/verifyEvents.js";
import { expectedEvents } from "../config/expectedEvents.js";
import { completeOnboarding } from "../utils/completeOnboarding.js";
import { validateRecommendation } from "../utils/validateRecommendation.js";
import { selectSizeIfMultiple } from "../utils/selectSizeIfMultiple.js";
import { addItemToWardrobe } from "../utils/addItemToWardrobe.js";
import { blockMarketingScripts } from "../utils/blockMarketingScripts.js";

test.setTimeout(180000);

test("Inpage basic flow", async ({ page }, testInfo) => {
  const startTime = Date.now();

  const url =
    process.env.TEST_URL || "https://www.underarmour.co.jp/f/dsg-1072366";

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
    await page.goto(url);

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

    // -----------------------------
    // Gatekeeping
    // -----------------------------

    const skipReason = getSkipReason(pdc);

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

    // -----------------------------
    // Open Inpage
    // -----------------------------

    await page.waitForFunction(
      () => {
        return (
          document.querySelector("#vs-inpage") ||
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
    } else {
      await clickWidget(page, flow);

      await waitForWidgetRender(page);
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
      isNewUser = await runFootwearFlow(page, bodyAPI);
    }
    if (flow === "kids") {
      isNewUser = await runKidsFlow(page, pdc);
    }
    if (flow === "noVisor") {
      isNewUser = await runNoVisorFlow(page, bodyAPI);
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

    // Wait for widget to re-render so the recommendation API has time to fire
    await waitForWidgetRender(page);

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

async function runFootwearFlow(page, bodyAPI) {
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

  // Step 3: Gender – select female
  await page.evaluate(() => {
    const modal = getWidgetHost()?.shadowRoot?.querySelector(
      "#vs-aoyama-main-modal",
    );
    const radios = modal?.querySelectorAll(
      '[data-test-id="gender-radio-buttons"] input[type="radio"]',
    );
    if (!radios?.length) return;
    const female = [...radios].find(
      (el) => el.value.toLowerCase() === "female",
    );
    if (female) {
      female.click();
      female.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await page.waitForTimeout(800);
  await clickNext();

  // Step 4: Footwear size – open picker, select first radio
  await page.evaluate(() => {
    const modal = getWidgetHost()?.shadowRoot?.querySelector(
      "#vs-aoyama-main-modal",
    );
    modal
      ?.querySelector('[data-test-id="open-sizes-footwear-picker"]')
      ?.click();
    const radio = modal?.querySelector("#footwear-picker input#radioButton-1");
    if (radio) {
      radio.click();
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await page.waitForTimeout(800);
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

  const bodyStatus = await waitForStatus(() => bodyAPI.getStatus(), 8000);
  expect(bodyStatus).toBe(200);

  return isNewUser;
}

// --------------------------------------------------
// Kids Flow
// --------------------------------------------------

async function runKidsFlow(page, _pdc) {
  console.log("Running Kids flow");

  // Wait for gender radio buttons to appear
  await page.waitForFunction(() =>
    findInShadow('input[name="selectKidGender"]'),
  );

  console.log("Gender radio buttons detected");

  // Click girl
  await page.evaluate(() => {
    const girlRadio = findInShadow(
      'input[name="selectKidGender"][value="girl"]',
    );

    if (!girlRadio) {
      throw new Error("Girl radio button not found");
    }

    girlRadio.click();
  });

  console.log("Clicked gender radio button");

  // Open age selector
  await page.evaluate(() => {
    const wrapper = document.querySelector("#vs-kid-app")?.nextElementSibling;
    const root = wrapper?.shadowRoot;
    if (!root) throw new Error("Kids widget shadow root not found");

    const ageSpan = root.querySelector("span.age-input-value");
    if (!ageSpan) throw new Error("Age span not found");

    ageSpan.click();
  });

  console.log("Opened age selector");

  // Wait for age sheet to appear
  await page.waitForFunction(() => {
    const wrapper = document.querySelector("#vs-kid-app")?.nextElementSibling;
    const root = wrapper?.shadowRoot;
    const sheet = root?.querySelector("#sheet");
    return sheet && sheet.querySelector("input[type='radio']");
  });

  // Select age option
  await page.evaluate(() => {
    const wrapper = document.querySelector("#vs-kid-app")?.nextElementSibling;
    const root = wrapper?.shadowRoot;
    const sheet = root?.querySelector("#sheet");
    if (!sheet) throw new Error("Kids age sheet not found");

    const radios = sheet.querySelectorAll(
      "gridcontainer > div.vs-radio-buttons > label > input[type='radio']",
    );
    if (!radios.length) throw new Error("No Kids age radio buttons found");

    const target = radios[5] || radios[0];
    target.click();
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });

  console.log("Selected age");

  /* -------------------- HEIGHT & WEIGHT -------------------- */

  console.log("Waiting for height and weight inputs...");

  await page.waitForFunction(() => {
    const wrapper = document.querySelector("#vs-kid-app")?.nextElementSibling;
    const root = wrapper?.shadowRoot;

    return (
      root &&
      root.querySelector('[data-test-id="kids-height-input-desktop"] input') &&
      root.querySelector('[data-test-id="kids-weight-input-desktop"] input')
    );
  });

  for (const [testId, value] of [
    ["kids-height-input-desktop", "120"],
    ["kids-weight-input-desktop", "25"],
  ]) {
    await page.evaluate(
      ({ testId, value }) => {
        const wrapper =
          document.querySelector("#vs-kid-app")?.nextElementSibling;
        const root = wrapper?.shadowRoot;

        const input = root?.querySelector(`[data-test-id="${testId}"] input`);

        if (!input) throw new Error(`Input not found: ${testId}`);

        input.focus();
        input.value = value;

        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));

        input.blur();
      },
      { testId, value },
    );
  }

  console.log("Filled height and weight");

  /* -------------------- PRIVACY POLICY -------------------- */

  await page.evaluate(() => {
    const wrapper = document.querySelector("#vs-kid-app")?.nextElementSibling;
    const root = wrapper?.shadowRoot;

    if (!root) return;

    const checkbox = root.querySelector(
      '[data-test-id="privacy-policy-checkbox"]',
    );

    if (checkbox && !checkbox.checked) {
      checkbox.click();
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  console.log("Checked privacy policy");

  /* -------------------- CTA BUTTON -------------------- */

  await page.evaluate(() => {
    const wrapper = document.querySelector("#vs-kid-app")?.nextElementSibling;
    const root = wrapper?.shadowRoot;

    if (!root) return;

    const nextButton = root.querySelector('[data-test-id="see-ideal-fit-btn"]');

    if (!nextButton) throw new Error("CTA button not found");

    nextButton.click();
  });

  console.log("Clicked See Your Perfect Fit");

  /* -------------------- WAIT FOR RESULT -------------------- */

  await page.waitForFunction(() => {
    const wrapper = document.querySelector("#vs-kid-app")?.nextElementSibling;
    const root = wrapper?.shadowRoot;

    return root?.querySelector('[data-test-id="kids-recommended-size"]');
  });

  console.log("Kids onboarding completed successfully.");

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

  await page.evaluate(() =>
    findInShadow('[data-test-id="gift-cta"]')?.click()
  );

  // Wait for onboarding to mount
  await page.waitForFunction(
    () => !!findInShadow('[data-test-id="input-age-desktop"]'),
    { timeout: 15000 }
  );

  console.log("Gift onboarding detected");

  // ── 2. Gender ─────────────────────────────────────────────────────────────

  await page.evaluate(() => {
    const radio = findInShadow('input[name="selectGender"][value="female"]');
    if (!radio) throw new Error("Female gender radio not found");
    radio.click();
    radio.dispatchEvent(new Event("change", { bubbles: true }));
  });

  console.log("Selected gender: female");

  // ── 3. Age ────────────────────────────────────────────────────────────────

  await page.evaluate(() =>
    findInShadow('[data-test-id="input-age-desktop"]')?.click()
  );

  // Wait for the age sheet modal to appear with at least one label option
  // Scoped to #sheet to avoid matching gender radios elsewhere in the widget
  await page.waitForFunction(
    () => !!findInShadow('#sheet label.radio-button-label'),
    { timeout: 10000 }
  );

  // Click the first label — safest way to trigger the underlying input[name="selectMetric"]
  await page.evaluate(() => {
    const label = findInShadow('#sheet label.radio-button-label');
    if (!label) throw new Error("Age label option not found in #sheet");
    label.click();
  });

  // Wait for the age field to turn from gray (rgb(183, 185, 185)) to black (rgb(25, 25, 25))
  await page.waitForFunction(() => {
    const el = findInShadow('[data-test-id="input-age-desktop"]');
    if (!el) return false;
    return window.getComputedStyle(el).color !== "rgb(183, 185, 185)";
  }, { timeout: 8000 });

  // Wait for age sheet to fully close before opening height
  await page.waitForFunction(() => {
    const sheet = findInShadow('#sheet');
    if (!sheet) return true;
    const s = window.getComputedStyle(sheet);
    return s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0;
  }, { timeout: 8000 });

  console.log("Selected age");

  // ── 4. Height ─────────────────────────────────────────────────────────────

  await page.waitForTimeout(600);

  await page.evaluate(() => findInShadow('[data-test-id="input-height-desktop"]')?.click());

  // wait for height sheet to open, then select first option
  await page.waitForFunction(
    () => !!findInShadow('#sheet label.radio-button-label'),
    { timeout: 10000 }
  );
  await page.evaluate(() => findInShadow('#sheet label.radio-button-label')?.click());

  // wait for height sheet to fully close
  await page.waitForFunction(() => {
    const sheet = findInShadow('#sheet');
    if (!sheet) return true;
    const s = window.getComputedStyle(sheet);
    return s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0;
  }, { timeout: 8000 });

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
  await clickWidget(page, "apparel");
  await waitForWidgetRender(page);

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
// Helpers
// --------------------------------------------------

async function waitForPDC(pdc) {
  const start = Date.now();

  while (Date.now() - start < 10000) {
    if (pdc.store !== "unknown") return;
    await new Promise((r) => setTimeout(r, 200));
  }
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
        root.querySelector('[data-test-id="open-brands-footwear-picker"]') // shoe step 6
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
  const selector = flow === "kids" ? "#vs-kid" : ":is(#vs-inpage, #vs-legacy-inpage)";

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
  const selector = flow === "kids" ? "#vs-kid" : ":is(#vs-inpage, #vs-legacy-inpage)";

  await page.evaluate((sel) => {
    document.querySelector(sel)?.scrollIntoView({ block: "center" });
  }, selector);

  await page.waitForSelector(selector, { state: "visible", timeout: 5000 });

  // force: true bypasses any overlay that sneaks in at click time
  await page.locator(selector).click({ force: true });
}

// --------------------------------------------------
// Overlay Cleanup
// --------------------------------------------------


function logResult(result) {
  console.log("QA_RESULT:", JSON.stringify(result));
}
