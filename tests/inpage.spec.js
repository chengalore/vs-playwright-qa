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
      // wait for overlays to appear and be dismissed before clicking
      await page.waitForTimeout(10000);

      await clickWidget(page, flow);

      await waitForWidgetRender(page);

      // remove overlays that appear when the widget opens
      await removeMarketingOverlays(page);
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

    // -----------------------------
    // Recommendation
    // -----------------------------

    if (flow !== "kids") {
      await validateRecommendation(eventWatcher);
    }

    // -----------------------------
    // Size + Wardrobe (apparel only)
    // -----------------------------

    if (flow === "apparel") {
      await selectSizeIfMultiple(page, eventWatcher);
      await page.waitForTimeout(3000);
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

    try {
      await Promise.race([
        validateRefresh(page, eventWatcher, recommendationAPI, flow),
        page.waitForTimeout(8000)
      ]);
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
  if (pdc.noVisor) return "Non-Visor";
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
  console.log("Validating PDP refresh behavior");

  eventWatcher.reset();

  await page.reload();
  await waitForWidget(page, flow);

  if (flow === "kids") {
    await clickKidsWidget(page);

    console.log("Waiting for kids recommendation after refresh");

    await page.waitForFunction(
      () => {
        const wrapper =
          document.querySelector("#vs-kid-app")?.nextElementSibling;
        const root = wrapper?.shadowRoot;

        return root?.querySelector('[data-test-id="kids-recommended-size"]');
      },
      { timeout: 10000 },
    );
  } else {
    await removeMarketingOverlays(page);
    await clickWidget(page, flow);

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
  }

  // -----------------------------------------
  // CHECK EVENTS
  // -----------------------------------------

  const schema =
    flow === "footwear"
      ? expectedEvents.refresh.footwear
      : flow === "kids"
        ? expectedEvents.refresh.kids
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
  if (pdc.productType?.toLowerCase() === "shoe") return "footwear";
  return "apparel";
}

// --------------------------------------------------
// Apparel Flow
// --------------------------------------------------

async function runApparelFlow(page, bodyAPI, eventWatcher, recommendationAPI) {
  const isNewUser = await isOnboardingVisible(page);

  if (isNewUser) {
    console.log("New user → running onboarding");

    await completeOnboarding(page);

    await removeMarketingOverlays(page);

    await waitForRecommendationReady(eventWatcher, recommendationAPI);

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
  console.log("Waiting for recommendation panel...");

  await waitForStatus(() => recommendationAPI.getStatus(), 15000);

  const start = Date.now();

  while (Date.now() - start < 15000) {
    const events = eventWatcher.getEvents();

    if (
      events.some((e) => e.startsWith("user-opened-panel-tryiton::")) ||
      events.some((e) => e.startsWith("user-saw-measurements-view::"))
    ) {
      console.log("Recommendation screen detected.");
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

// --------------------------------------------------
// Widget Wait
// --------------------------------------------------

async function waitForWidget(page, flow) {
  const selector = flow === "kids" ? "#vs-kid" : "#vs-inpage";

  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;

      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    },
    selector,
    { timeout: 20000 },
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
  const selector = flow === "kids" ? "#vs-kid" : "#vs-inpage";

  await page.evaluate((sel) => {
    document.querySelector(sel)?.scrollIntoView({ block: "center" });
  }, selector);

  await removeMarketingOverlays(page);

  await page.waitForSelector(selector, { state: "visible", timeout: 5000 });

  // force: true bypasses any overlay that sneaks in at click time
  await page.locator(selector).click({ force: true });
}

// --------------------------------------------------
// Overlay Cleanup
// --------------------------------------------------

async function removeMarketingOverlays(page) {
  const maxDuration = 8000;
  const quietThreshold = 1000; // stop after 1s with no overlays found
  const checkInterval = 300;

  const start = Date.now();
  let lastFoundAt = start;

  while (Date.now() - start < maxDuration) {
    const found = await page.evaluate(() => {
      let dismissed = false;

      // Buyee
      document
        .querySelectorAll("#buyee-bcFrame, #buyee-bcSection, .bcModalBase")
        .forEach((el) => {
          el.remove();
          dismissed = true;
        });
      document.querySelectorAll(".bcIntro__closeBtn").forEach((el) => {
        el.click();
        dismissed = true;
      });

      // WorldShopping
      const wsShadow = document.querySelector(
        "#zigzag-worldshopping-checkout",
      )?.shadowRoot;
      if (wsShadow) {
        const wsInner = wsShadow.querySelector(
          "#zigzag-worldshopping-checkout",
        );
        if (wsInner && wsInner.style.display !== "none") {
          wsShadow.querySelector("#zigzag-test__banner-close-popup")?.click();
          wsShadow.querySelector("#zigzag-test__banner-hide")?.click();
          wsShadow
            .querySelector(
              ".src-components-notice-___NoticeV2__closeIcon___Hpc7A",
            )
            ?.click();
          wsInner.style.display = "none";
          dismissed = true;
        }
      }

      // KARTE
      document.querySelectorAll(".karte-close").forEach((el) => {
        el.click();
        dismissed = true;
      });

      return dismissed;
    });

    if (found) {
      lastFoundAt = Date.now();
    } else if (Date.now() - lastFoundAt >= quietThreshold) {
      break; // 1s of quiet — overlays are gone
    }

    await page.waitForTimeout(checkInterval);
  }
}

function logResult(result) {
  console.log("QA_RESULT:", JSON.stringify(result));
}
