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

test.setTimeout(120000);

test("Inpage basic flow", async ({ page }) => {
  const firedEvents = startVirtusizeEventWatcher(page);
  const pdcData = startPDCWatcher(page);
  const recommendationAPI = startRecommendationWatcher(page);
  const bodyAPI = startBodyMeasurementWatcher(page);

  await page.goto("https://www.underarmour.co.jp/f/dsg-1072366");

  await page.waitForSelector(
    "#vs-inpage, #vs-kid, #vs-inpage-mini, #vs-smart-table",
    { timeout: 60000 }
  );

  await page.click("#vs-inpage");
  await page.waitForTimeout(3000);

  const isNewUser = firedEvents.includes("user-saw-onboarding-screen");

  if (isNewUser) {
    console.log("New user → running onboarding");
    await completeOnboarding(page);

    const bodyStatus = await waitForStatus(() => bodyAPI.getStatus(), 10000);

    expect(bodyStatus).toBe(200);
    console.log("Body measurement saved");
  } else {
    console.log("Returning user → skip onboarding");
  }

  // Validate recommendation
  await validateRecommendation(page, firedEvents, recommendationAPI, isNewUser);

  // Select size if multiple sizes exist
  await selectSizeIfMultiple(page, firedEvents);

  // Validate strict events (no wardrobe yet)
  const baselineFailures = await verifyEvents(
    page,
    firedEvents,
    expectedEvents.strict.baseline
  );

  const recommendationFailures = await verifyEvents(
    page,
    firedEvents,
    expectedEvents.strict.recommendation
  );

  const panelFailures = await verifyEvents(
    page,
    firedEvents,
    expectedEvents.strict.panels
  );

  expect(
    [...baselineFailures, ...recommendationFailures, ...panelFailures].length
  ).toBe(0);

  console.log(`
Store: ${pdcData.store}
Product Type: ${pdcData.productType}
Gender: ${pdcData.gender}
User Type: ${isNewUser ? "NEW" : "RETURNING"}
Result: PASS
`);
});

async function waitForStatus(getter, timeout = 10000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const value = getter();
    if (value !== null && value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 200));
  }

  return null;
}
