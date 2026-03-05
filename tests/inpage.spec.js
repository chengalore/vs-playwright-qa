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

test.setTimeout(90000);

test("Inpage basic flow", async ({ page }, testInfo) => {
  const startTime = Date.now();

  const url =
    process.env.TEST_URL || "https://www.underarmour.co.jp/f/dsg-1072366";

  console.log("Testing URL:", url);

  const eventWatcher = startVirtusizeEventWatcher(page);
  const pdc = startPDCWatcher(page);
  const recommendationAPI = startRecommendationWatcher(page);
  const bodyAPI = startBodyMeasurementWatcher(page);

  await page.addInitScript(() => {
    window.getWidgetHost = () =>
      document.querySelector("#router-view-wrapper") ||
      document.querySelector("#vs-aoyama")?.nextElementSibling;
  });

  try {
    await page.goto(url);
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

    await page.waitForSelector("#vs-inpage", { state: "visible", timeout: 15000 });

    // remove overlays again (they may appear late)
    await removeMarketingOverlays(page);

    await clickInpage(page);

    await waitForWidgetRender(page);

    const flow = detectFlow(pdc);
    console.log("Flow:", flow);

    let isNewUser;
    if (flow === "apparel") {
      isNewUser = await runApparelFlow(page, bodyAPI);
    }
    if (flow === "footwear") {
      isNewUser = await runFootwearFlow(page, bodyAPI);
    }

    // -----------------------------
    // Recommendation
    // -----------------------------

    await validateRecommendation(
      page,
      eventWatcher,
      recommendationAPI,
      isNewUser,
      flow,
    );

    // -----------------------------
    // Size + Wardrobe (apparel only)
    // -----------------------------

    if (flow === "apparel") {
      await selectSizeIfMultiple(page, eventWatcher);
      await addItemToWardrobe(page, eventWatcher.getEvents());
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

    // -----------------------------
    // Core Event Validation
    // -----------------------------

    await validateCoreEvents(page, eventWatcher, flow);

    // -----------------------------
    // Refresh Validation
    // -----------------------------

    try {
      await validateRefresh(page, eventWatcher, recommendationAPI, flow);
    } catch (error) {
      console.warn("Refresh validation failed (non-fatal):", error.message);
    }

    // -----------------------------
    // PASS
    // -----------------------------

    logResult({
      url,
      store: pdc.store,
      productType: pdc.productType,
      userType: isNewUser ? "NEW" : "RETURNING",
      status: testInfo.status,
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
  if (pdc.noVisor) return "Non-Visor";
  if (excludedTypes.includes(pdc.productType?.toLowerCase()))
    return "Non apparel item";

  return null;
}

// --------------------------------------------------
// Validators
// --------------------------------------------------

async function validateCoreEvents(page, eventWatcher, flow) {
  const events = eventWatcher.getEvents();

  const baseline = await verifyEvents(
    page,
    events,
    expectedEvents.strict.baseline,
  );

  const flowEvents = flow === "footwear"
    ? await verifyEvents(page, events, expectedEvents.strict.footwear)
    : [
        ...await verifyEvents(page, events, expectedEvents.strict.recommendation),
        ...await verifyEvents(page, events, expectedEvents.strict.panels),
      ];

  const missing = [...baseline, ...flowEvents];

  if (missing.length > 0) {
    const error = new Error(`Missing events: ${missing.join(", ")}`);
    error.missingEvents = missing;
    throw error;
  }

  validateStrictDuplicates(eventWatcher);
}

async function validateRefresh(page, eventWatcher, recommendationAPI, flow) {
  console.log("Validating PDP refresh behavior");

  eventWatcher.reset();

  await page.reload();
  await page.waitForSelector("#vs-inpage", { state: "visible", timeout: 15000 });
  await removeMarketingOverlays(page);
  await clickInpage(page);

  // Wait for widget to re-render so the recommendation API has time to fire
  await waitForWidgetRender(page);

  // -----------------------------------------
  // CHECK RECOMMENDATION API REFIRE
  // -----------------------------------------

  const recStatus = await waitForStatus(
    () => recommendationAPI.getStatus(),
    5000,
  );

  if (recStatus !== 200) {
    throw new Error(
      `Recommendation API did not refire after refresh (status: ${recStatus})`,
    );
  }

  // -----------------------------------------
  // CHECK EVENTS
  // -----------------------------------------

  const refreshed = eventWatcher.getEvents();
  const schema = flow === "footwear"
    ? expectedEvents.refresh.footwear
    : expectedEvents.refresh.apparel;

  const failures = await verifyEvents(page, refreshed, schema);

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
  if (pdc.productType?.toLowerCase() === "shoe") return "footwear";
  return "apparel";
}

// --------------------------------------------------
// Apparel Flow
// --------------------------------------------------

async function runApparelFlow(page, bodyAPI) {
  const isNewUser = await isOnboardingVisible(page);

  if (isNewUser) {
    console.log("New user → running onboarding");

    await completeOnboarding(page);

    const bodyStatus = await waitForStatus(() => bodyAPI.getStatus(), 5000);
    expect(bodyStatus).toBe(200);
  }

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
    () => (getWidgetHost()?.shadowRoot?.querySelectorAll('[data-test-id="toeShape-select-item-btn"]')?.length ?? 0) > 0,
    { timeout: 15000 },
  );
  await page.evaluate(() => {
    const btns = getWidgetHost()?.shadowRoot?.querySelectorAll('[data-test-id="toeShape-select-item-btn"]');
    if (btns?.length) btns[Math.floor(btns.length / 2)].click();
  });
  await clickNext();

  // Step 3: Gender – select female
  await page.evaluate(() => {
    const modal = getWidgetHost()?.shadowRoot?.querySelector("#vs-aoyama-main-modal");
    const radios = modal?.querySelectorAll('[data-test-id="gender-radio-buttons"] input[type="radio"]');
    if (!radios?.length) return;
    const female = [...radios].find((el) => el.value.toLowerCase() === "female");
    if (female) {
      female.click();
      female.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await page.waitForTimeout(800);
  await clickNext();

  // Step 4: Footwear size – open picker, select first radio
  await page.evaluate(() => {
    const modal = getWidgetHost()?.shadowRoot?.querySelector("#vs-aoyama-main-modal");
    modal?.querySelector('[data-test-id="open-sizes-footwear-picker"]')?.click();
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
    const modal = getWidgetHost()?.shadowRoot?.querySelector("#vs-aoyama-main-modal");
    const checkbox = modal?.querySelector('[data-test-id="footwear-privacy-policy"]');
    if (checkbox && !checkbox.checked) {
      checkbox.click();
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await page.waitForTimeout(800);
  await clickNext();

  // Step 6: Brand – open picker, select first option, wait for picker to close
  await page.evaluate(() => {
    const modal = getWidgetHost()?.shadowRoot?.querySelector("#vs-aoyama-main-modal");
    modal?.querySelector('[data-test-id="open-brands-footwear-picker"]')?.click();
  });
  await page.waitForFunction(
    () => !!getWidgetHost()?.shadowRoot?.querySelector('[data-test-id="footwear-picker"]'),
    { timeout: 5000 },
  );
  await page.evaluate(() => {
    const root = getWidgetHost()?.shadowRoot;
    root?.querySelector('[data-test-id="footwear-picker"] label[for="radioButton-0"]')?.click();
  });
  await page.waitForFunction(
    () => {
      const picker = getWidgetHost()?.shadowRoot?.querySelector('[data-test-id="footwear-picker"]');
      if (!picker) return true;
      const style = window.getComputedStyle(picker);
      return style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
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
  await page.waitForFunction(() => {
    return !!getWidgetHost()?.shadowRoot;
  }, { timeout: 15000 });

  // Wait for ANY known screen
  await page.waitForFunction(() => {
    const root = getWidgetHost()?.shadowRoot;
    if (!root) return false;

    return (
      root.querySelector('[data-test-id="input-age"]') ||                    // apparel onboarding
      root.querySelector('[data-test-id="size-btn"]') ||                     // apparel recommendation
      root.querySelector('[data-test-id="no-visor-recommended-size"]') ||   // footwear recommendation
      root.querySelector('[data-test-id="footWidth-select-item-btn"]') ||    // shoe step 1
      root.querySelector('[data-test-id="toeShape-select-item-btn"]') ||     // shoe step 2
      root.querySelector('[data-test-id="open-sizes-footwear-picker"]') ||   // shoe step 4
      root.querySelector('[data-test-id="open-brands-footwear-picker"]')     // shoe step 6
    );
  }, { timeout: 20000 });
}

async function isOnboardingVisible(page) {
  return await page.evaluate(() => {
    return !!getWidgetHost()?.shadowRoot?.querySelector('[data-test-id="input-age"]');
  });
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

// --------------------------------------------------
// Inpage Click
// --------------------------------------------------

async function clickInpage(page) {
  await page.evaluate(() =>
    document.querySelector("#vs-inpage")?.scrollIntoView({ block: "center" }),
  );
  try {
    await page.click("#vs-inpage", { timeout: 5000 });
  } catch {
    // Element may still be partially obscured — force-click as fallback
    await page.evaluate(() => document.querySelector("#vs-inpage")?.click());
  }
}

// --------------------------------------------------
// Overlay Cleanup
// --------------------------------------------------

async function removeMarketingOverlays(page) {
  await page.waitForTimeout(2000); // wait for overlays to appear

  await page.evaluate(() => {
    // Buyee
    document
      .querySelectorAll("#buyee-bcFrame, #buyee-bcSection, .bcModalBase")
      .forEach((el) => el.remove());

    // WorldShopping
    document.querySelector("#zigzag-worldshopping-checkout")?.remove();

    // KARTE
    document.querySelectorAll(".karte-close").forEach((el) => el.click());
  });
}

function logResult(result) {
  console.log("QA_RESULT:", JSON.stringify(result));
}
