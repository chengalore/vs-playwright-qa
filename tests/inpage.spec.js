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

test.setTimeout(60000);

test("Inpage basic flow", async ({ page }, testInfo) => {
  const startTime = Date.now();

  const url =
    process.env.TEST_URL || "https://www.underarmour.co.jp/f/dsg-1072366";

  console.log("Testing URL:", url);

  const eventWatcher = startVirtusizeEventWatcher(page);
  const pdc = startPDCWatcher(page);
  const recommendationAPI = startRecommendationWatcher(page);
  const bodyAPI = startBodyMeasurementWatcher(page);

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

    await page.waitForSelector("#vs-inpage", { timeout: 15000 });
    await page.click("#vs-inpage");

    await waitForWidgetRender(page);

    const isNewUser = await isOnboardingVisible(page);

    if (isNewUser) {
      console.log("New user → running onboarding");

      await completeOnboarding(page);

      const bodyStatus = await waitForStatus(() => bodyAPI.getStatus(), 5000);

      expect(bodyStatus).toBe(200);
    } else {
      console.log("Returning user → skip onboarding");
    }

    // -----------------------------
    // Recommendation
    // -----------------------------

    await validateRecommendation(
      page,
      eventWatcher.getEvents(),
      recommendationAPI,
      isNewUser
    );

    // -----------------------------
    // Size + Wardrobe
    // -----------------------------

    await selectSizeIfMultiple(page, eventWatcher.getEvents());
    await addItemToWardrobe(page, eventWatcher.getEvents());

    // -----------------------------
    // Core Event Validation
    // -----------------------------

    await validateCoreEvents(page, eventWatcher.getEvents());

    // -----------------------------
    // Refresh Validation
    // -----------------------------

    await validateRefresh(page, eventWatcher);

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

/* --------------------------------------------------
   Gatekeeping
-------------------------------------------------- */

function getSkipReason(pdc) {
  const excludedTypes = ["shoe", "bag", "wallet", "clutch", "panties"];

  if (pdc.validProduct === false) {
    return "Invalid Product (validProduct=false)";
  }

  if (pdc.noVisor) {
    return "Non-Visor";
  }

  if (excludedTypes.includes(pdc.productType?.toLowerCase())) {
    return "Unsupported Product Type";
  }

  return null;
}

/* --------------------------------------------------
   Validators
-------------------------------------------------- */

async function validateCoreEvents(page, events) {
  const baseline = await verifyEvents(
    page,
    events,
    expectedEvents.strict.baseline
  );

  const recommendation = await verifyEvents(
    page,
    events,
    expectedEvents.strict.recommendation
  );

  const panels = await verifyEvents(page, events, expectedEvents.strict.panels);

  const missing = [...baseline, ...recommendation, ...panels];

  if (missing.length > 0) {
    const error = new Error(`Missing events: ${missing.join(", ")}`);
    error.missingEvents = missing;
    throw error;
  }
}

async function validateRefresh(page, eventWatcher) {
  console.log("Validating PDP refresh behavior");

  eventWatcher.reset();

  await page.reload();
  await page.waitForSelector("#vs-inpage", { timeout: 15000 });
  await page.click("#vs-inpage");

  await verifyEvents(
    page,
    eventWatcher.getEvents(),
    expectedEvents.strict.recommendation
  );

  const refreshed = eventWatcher.getEvents();

  const failures = [
    ...(await verifyEvents(page, refreshed, expectedEvents.strict.baseline)),
    ...(await verifyEvents(
      page,
      refreshed,
      expectedEvents.strict.recommendation
    )),
    ...(await verifyEvents(page, refreshed, expectedEvents.strict.size)),
  ];

  if (failures.length > 0) {
    const error = new Error(`Refresh missing events: ${failures.join(", ")}`);
    error.missingEvents = failures;
    throw error;
  }
}

/* --------------------------------------------------
   Helpers
-------------------------------------------------- */

async function waitForPDC(pdc) {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (pdc.store !== "unknown") break;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function waitForWidgetRender(page) {
  await page.waitForFunction(
    () => {
      const host =
        document.querySelector("#router-view-wrapper") ||
        document.querySelector("#vs-aoyama")?.nextElementSibling;

      const root = host?.shadowRoot;

      return (
        root?.querySelector('[data-test-id="input-age"]') ||
        root?.querySelector('[data-test-id="size-btn"]')
      );
    },
    { timeout: 8000 }
  );
}

async function isOnboardingVisible(page) {
  return await page.evaluate(() => {
    const host =
      document.querySelector("#router-view-wrapper") ||
      document.querySelector("#vs-aoyama")?.nextElementSibling;

    return !!host?.shadowRoot?.querySelector('[data-test-id="input-age"]');
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

function logResult(result) {
  console.log("QA_RESULT:", JSON.stringify(result));
}
