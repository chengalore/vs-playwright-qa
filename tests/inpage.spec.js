import { test, expect } from "@playwright/test";
import { startVirtusizeEventWatcher } from "../utils/eventWatcher.js";
import { startPDCWatcher } from "../utils/pdcWatcher.js";
import { verifyEvents } from "../utils/verifyEvents.js";
import { expectedEvents } from "../config/expectedEvents.js";

test.setTimeout(120000);

test("Inpage basic flow", async ({ page }) => {
  const firedEvents = startVirtusizeEventWatcher(page);
  const pdcData = startPDCWatcher(page);

  await page.goto("https://www.underarmour.co.jp/f/dsg-1072366");

  await page.waitForSelector(
    "#vs-inpage, #vs-kid, #vs-inpage-mini, #vs-smart-table",
    {
      timeout: 20000,
    }
  );

  const missingBefore = await verifyEvents(
    page,
    firedEvents,
    expectedEvents.inpage.beforeClick
  );

  const missingWidget = await verifyEvents(
    page,
    firedEvents,
    expectedEvents.inpage.widgetClick
  );

  const allMissing = [...missingBefore, ...missingWidget];
  const match = allMissing.length === 0;

  console.log(`
----------------------------------
Store: ${pdcData.store}
ProductType: ${pdcData.productType}
Gender: ${pdcData.gender}

Events Fired:
${firedEvents.map((e) => `  - ${e}`).join("\n")}

Missing: ${allMissing.length ? allMissing.join(", ") : "none"}
Match: ${match}
----------------------------------
`);

  expect(match).toBe(true);
});
