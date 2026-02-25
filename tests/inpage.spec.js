import { test, expect } from "@playwright/test";
import { startVirtusizeEventWatcher } from "../utils/eventWatcher.js";
import { startPDCWatcher } from "../utils/pdcWatcher.js";
import { startRecommendationWatcher } from "../utils/recommendationWatcher.js";
import { verifyEvents } from "../utils/verifyEvents.js";
import { expectedEvents } from "../config/expectedEvents.js";
import { completeOnboarding } from "../utils/completeOnboarding.js";
import { validateRecommendation } from "../utils/validateRecommendation.js";
import { startBodyMeasurementWatcher } from "../utils/bodyMeasurementWatcher.js";
import { selectSizeIfMultiple } from "../utils/selectSizeIfMultiple.js";
import { addItemToWardrobe } from "../utils/addItemToWardrobe.js";

test.setTimeout(60000);

test("Inpage basic flow", async ({ page }, testInfo) => {
  const url =
    process.env.TEST_URL || "https://www.underarmour.co.jp/f/dsg-1072366";

  const startTime = Date.now();

  try {
    const eventWatcher = startVirtusizeEventWatcher(page);
    const pdcData = startPDCWatcher(page);
    const recommendationAPI = startRecommendationWatcher(page);
    const bodyAPI = startBodyMeasurementWatcher(page);

    console.log("Testing URL:", url);

    await page.goto(url);

    await waitForPDC(pdcData);

    const skipReason = getSkipReason(pdcData);
    if (skipReason) {
      logStructuredResult({
        url,
        store: pdcData.store,
        productType: pdcData.productType,
        status: "SKIPPED",
        reason: skipReason,
        browser: testInfo.project.name,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    await page.waitForSelector("#vs-inpage", { timeout: 15000 });
    await page.click("#vs-inpage");

    await waitForWidgetRender(page);

    const isNewUser = await isOnboardingVisible(page);

    if (isNewUser) {
      await completeOnboarding(page);

      const bodyStatus = await waitForStatus(() => bodyAPI.getStatus(), 5000);

      expect(bodyStatus).toBe(200);
    }

    await validateRecommendation(
      page,
      eventWatcher.getEvents(),
      recommendationAPI,
      isNewUser
    );

    await selectSizeIfMultiple(page, eventWatcher.getEvents());
    await addItemToWardrobe(page, eventWatcher.getEvents());

    await validateStrictEvents(page, eventWatcher.getEvents());

    await validateRefresh(page, eventWatcher);

    logStructuredResult({
      url,
      store: pdcData.store,
      productType: pdcData.productType,
      userType: isNewUser ? "NEW" : "RETURNING",
      status: "PASS",
      browser: testInfo.project.name,
      durationMs: Date.now() - startTime,
    });
  } catch (error) {
    logStructuredResult({
      url,
      status: "FAIL",
      browser: testInfo.project.name,
      error: error.message,
      durationMs: Date.now() - startTime,
    });
    throw error; // keep CI failing correctly
  }
});

/* ---------- Structured Result ---------- */

function logStructuredResult(data) {
  const result = {
    ...data,
    timestamp: new Date().toISOString(),
  };

  console.log("QA_RESULT:", JSON.stringify(result));
}

/* ---------- Helpers ---------- */

async function waitForPDC(pdcData) {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (pdcData.store !== "unknown") break;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function getSkipReason(pdcData) {
  const excludedTypes = ["shoe", "bag", "wallet", "clutch", "panties"];
  if (pdcData.validProduct === false) {
    return "Invalid Product (PDC validProduct=false)";
  }

  if (excludedTypes.includes(pdcData.productType?.toLowerCase())) {
    return "Unsupported Product Type";
  }

  if (pdcData.noVisor) {
    return "Non-Visor";
  }

  return null;
}

async function waitForWidgetRender(page) {
  await page.waitForFunction(
    () => {
      const host =
        document.querySelector("#router-view-wrapper") ||
        document.querySelector("#vs-aoyama")?.nextElementSibling;

      if (!host?.shadowRoot) return false;

      const root = host.shadowRoot;

      return (
        root.querySelector('[data-test-id="input-age"]') ||
        root.querySelector('[data-test-id="size-btn"]')
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

    const root = host?.shadowRoot;
    return !!root?.querySelector('[data-test-id="input-age"]');
  });
}

async function validateStrictEvents(page, events) {
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

  expect([...baseline, ...recommendation, ...panels].length).toBe(0);
}

async function validateRefresh(page, eventWatcher) {
  eventWatcher.reset();

  await page.reload();
  await page.waitForSelector("#vs-inpage", { timeout: 15000 });
  await page.click("#vs-inpage");

  await verifyEvents(
    page,
    eventWatcher.getEvents(),
    expectedEvents.strict.recommendation
  );

  const refreshedEvents = eventWatcher.getEvents();

  const failures = [
    ...(await verifyEvents(
      page,
      refreshedEvents,
      expectedEvents.strict.baseline
    )),
    ...(await verifyEvents(
      page,
      refreshedEvents,
      expectedEvents.strict.recommendation
    )),
    ...(await verifyEvents(page, refreshedEvents, expectedEvents.strict.size)),
  ];

  expect(failures.length).toBe(0);
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
