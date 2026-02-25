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

test("Inpage basic flow", async ({ page }) => {
  const eventWatcher = startVirtusizeEventWatcher(page);
  const pdcData = startPDCWatcher(page);
  const recommendationAPI = startRecommendationWatcher(page);
  const bodyAPI = startBodyMeasurementWatcher(page);

  const url =
    process.env.TEST_URL || "https://www.underarmour.co.jp/f/dsg-1072366";

  console.log("Testing URL:", url);

  await page.goto(url);

  /* ---------------------------------
     Wait briefly for PDC to populate
  ---------------------------------- */

  const pdcStart = Date.now();
  while (Date.now() - pdcStart < 5000) {
    if (pdcData.store !== "unknown") break;
    await page.waitForTimeout(100);
  }

  console.log("PDC:", pdcData);

  /* ---------------------------------
     Early Gatekeeping
  ---------------------------------- */

  const excludedTypes = ["shoe", "bag", "wallet", "clutch", "panties"];

  if (excludedTypes.includes(pdcData.productType?.toLowerCase())) {
    console.log(`
Store: ${pdcData.store}
Product Type: ${pdcData.productType}
Result: SKIPPED (Unsupported Product Type)
`);
    return;
  }

  if (pdcData.noVisor) {
    console.log(`
Store: ${pdcData.store}
Product Type: ${pdcData.productType}
Result: SKIPPED (Non-Visor)
`);
    return;
  }

  /* ---------------------------------
     Wait for Regular Inpage Only
  ---------------------------------- */

  await page.waitForSelector("#vs-inpage", { timeout: 15000 });

  await page.click("#vs-inpage");

  /* ---------------------------------
     Wait for Onboarding or Recommendation
  ---------------------------------- */

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

  /* ---------------------------------
     Detect User State
  ---------------------------------- */

  const isNewUser = await page.evaluate(() => {
    const host =
      document.querySelector("#router-view-wrapper") ||
      document.querySelector("#vs-aoyama")?.nextElementSibling;

    const root = host?.shadowRoot;
    return !!root?.querySelector('[data-test-id="input-age"]');
  });

  if (isNewUser) {
    console.log("New user → running onboarding");

    await completeOnboarding(page);

    const bodyStatus = await waitForStatus(() => bodyAPI.getStatus(), 5000);

    expect(bodyStatus).toBe(200);
  } else {
    console.log("Returning user → skip onboarding");
  }

  /* ---------------------------------
     Recommendation Validation
  ---------------------------------- */

  await validateRecommendation(
    page,
    eventWatcher.getEvents(),
    recommendationAPI,
    isNewUser
  );

  /* ---------------------------------
     Size + Wardrobe
  ---------------------------------- */

  await selectSizeIfMultiple(page, eventWatcher.getEvents());
  await addItemToWardrobe(page, eventWatcher.getEvents());

  /* ---------------------------------
     Strict Event Validation
  ---------------------------------- */

  const baselineFailures = await verifyEvents(
    page,
    eventWatcher.getEvents(),
    expectedEvents.strict.baseline
  );

  const recommendationFailures = await verifyEvents(
    page,
    eventWatcher.getEvents(),
    expectedEvents.strict.recommendation
  );

  const panelFailures = await verifyEvents(
    page,
    eventWatcher.getEvents(),
    expectedEvents.strict.panels
  );

  expect(
    [...baselineFailures, ...recommendationFailures, ...panelFailures].length
  ).toBe(0);

  /* ---------------------------------
     Refresh Validation
  ---------------------------------- */

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

  const refreshedEvents = eventWatcher.getEvents();

  const refreshFailures = [
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

  expect(refreshFailures.length).toBe(0);

  console.log(`
Store: ${pdcData.store}
Product Type: ${pdcData.productType}
User Type: ${isNewUser ? "NEW" : "RETURNING"}
Result: PASS
`);
});

/* ---------------------------------
   Helper
---------------------------------- */

async function waitForStatus(getter, timeout = 5000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const value = getter();
    if (value !== null && value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 100));
  }

  return null;
}
