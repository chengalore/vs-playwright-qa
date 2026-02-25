import { test, expect } from "@playwright/test";
import { startVirtusizeEventWatcher } from "../utils/eventWatcher.js";
import { startPDCWatcher } from "../utils/pdcWatcher.js";
import { verifyEvents } from "../utils/verifyEvents.js";
import { expectedEvents } from "../config/expectedEvents.js";
import { startRecommendationWatcher } from "../utils/recommendationWatcher.js";

test.setTimeout(120000);

test("Inpage basic flow", async ({ page }) => {
  const firedEvents = startVirtusizeEventWatcher(page);
  const pdcData = startPDCWatcher(page);
  const recommendationAPI = startRecommendationWatcher(page);

  await page.goto("https://www.underarmour.co.jp/f/dsg-1072366");

  await page.waitForSelector(
    "#vs-inpage, #vs-kid, #vs-inpage-mini, #vs-smart-table",
    { timeout: 20000 }
  );

  await page.click("#vs-inpage");
  await page.waitForTimeout(5000);

  // --- Detect User Type ---
  const isNewUser = firedEvents.includes("user-saw-onboarding-screen");

  // --- Verify Baseline + Widget ---
  const missingBaseline = await verifyEvents(
    page,
    firedEvents,
    expectedEvents.strict.baseline
  );

  const missingWidget = await verifyEvents(
    page,
    firedEvents,
    expectedEvents.strict.widget
  );

  // --- Verify Recommendation (ONLY if returning user) ---
  let missingRecommendation = [];
  let apiFailure = false;

  if (!isNewUser) {
    missingRecommendation = await verifyEvents(
      page,
      firedEvents,
      expectedEvents.strict.recommendation,
      15000
    );

    const apiStatus = recommendationAPI.getStatus();
    if (apiStatus !== 200) {
      apiFailure = true;
    }
  }

  // --- Assemble Strict Failures ---
  const strictFailures = [
    ...missingBaseline,
    ...missingWidget,
    ...missingRecommendation,
  ];

  if (apiFailure) {
    strictFailures.push("size-recommendation-api-failed");
  }

  const pass = strictFailures.length === 0;

  console.log(`
----------------------------------
Store: ${pdcData.store}
ProductType: ${pdcData.productType}
Gender: ${pdcData.gender}
UserType: ${isNewUser ? "NEW" : "RETURNING"}

Events Fired:
${firedEvents.map((e) => `  - ${e}`).join("\n")}

STRICT Missing:
${strictFailures.length ? strictFailures.join(", ") : "none"}

FINAL RESULT: ${pass ? "PASS" : "FAIL"}
----------------------------------
`);

  expect(pass).toBe(true);
});
