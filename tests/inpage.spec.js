import { test, expect } from "@playwright/test";
import { startVirtusizeEventWatcher } from "../utils/eventWatcher.js";
import { startPDCWatcher } from "../utils/pdcWatcher.js";
import { startRecommendationWatcher } from "../utils/recommendationWatcher.js";
import { verifyEvents } from "../utils/verifyEvents.js";
import { expectedEvents } from "../config/expectedEvents.js";
import { completeOnboarding } from "../utils/completeOnboarding.js";
import { validateRecommendation } from "../utils/validateRecommendation.js";

test.setTimeout(120000);

test("Inpage basic flow", async ({ page }) => {
  const firedEvents = startVirtusizeEventWatcher(page);
  const pdcData = startPDCWatcher(page);
  const recommendationAPI = startRecommendationWatcher(page);

  await page.goto("https://www.underarmour.co.jp/f/dsg-1072366");

  // Wait for any supported widget type
  await page.waitForSelector(
    "#vs-inpage, #vs-kid, #vs-inpage-mini, #vs-smart-table",
    { timeout: 60000 }
  );

  await page.click("#vs-inpage");
  await page.waitForTimeout(4000);

  const isNewUser = firedEvents.includes("user-saw-onboarding-screen");

  if (isNewUser) {
    console.log("New user detected, running onboarding flow...");
    await completeOnboarding(page);
  } else {
    console.log("Returning user detected, skipping onboarding.");
  }

  await validateRecommendation(page, firedEvents, recommendationAPI, isNewUser);

  const allStrictEvents = Object.values(expectedEvents.strict).flat();
  const strictFailures = await verifyEvents(page, firedEvents, allStrictEvents);

  const passed = strictFailures.length === 0;

  console.log(`
--------------------------------------------------
Store: ${pdcData.store}
Product Type: ${pdcData.productType}
Gender: ${pdcData.gender}
User Type: ${isNewUser ? "NEW" : "RETURNING"}

Events Fired:
${firedEvents.map((e) => `  - ${e}`).join("\n")}

Strict Missing:
${strictFailures.length ? strictFailures.join(", ") : "none"}

Result: ${passed ? "PASS" : "FAIL"}
--------------------------------------------------
`);

  expect(passed).toBe(true);
});
