/**
 * Shared flow helpers used by both tests/inpage.spec.js and tests/agent-qa.spec.js.
 *
 * All functions receive their dependencies as parameters so they are portable
 * across different test contexts.
 */

import { expect } from "@playwright/test";
import { completeOnboarding } from "./completeOnboarding.js";
import { verifyEvents } from "./verifyEvents.js";
import { expectedEvents } from "../config/expectedEvents.js";
import { validateRecommendation } from "./validateRecommendation.js";
import { selectSizeIfMultiple } from "./selectSizeIfMultiple.js";
import { addItemToWardrobe } from "./addItemToWardrobe.js";

// --------------------------------------------------
// Gatekeeping
// --------------------------------------------------

export function getSkipReason(pdc) {
  const excludedTypes = ["panties"];
  if (pdc.validProduct === false) return "Invalid Product (validProduct=false)";
  if (excludedTypes.includes(pdc.productType?.toLowerCase()))
    return "Non apparel item";
  return null;
}

// --------------------------------------------------
// Flow Detection
// --------------------------------------------------

export function isBagProduct(pdc) {
  const bagTypes = ["bag", "clutch", "wallet"];
  return bagTypes.includes(pdc.productType?.toLowerCase());
}

export function detectFlow(pdc) {
  const gender = pdc.gender?.toLowerCase();
  const isKid = pdc.isKid || gender === "boy" || gender === "girl";
  if (isKid) return "kids";
  if (pdc.noVisor) return "noVisor";
  if (pdc.productType?.toLowerCase() === "shoe") return "footwear";
  return "apparel";
}

export async function detectGiftEntry(page) {
  return await page.evaluate(() => {
    return !!findInShadow('[data-test-id="gift-cta"]');
  });
}

// --------------------------------------------------
// PDC Wait
// --------------------------------------------------

export async function waitForPDC(pdc) {
  if (pdc.validProduct === true) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await Promise.race([pdc._whenValid, sleep(15000)]);

  if (pdc.validProduct === true) return;
  if (pdc.validProduct === undefined) return;

  await Promise.race([pdc._whenValid, sleep(25000)]);
}

// --------------------------------------------------
// Widget Wait / Click
// --------------------------------------------------

export async function waitForWidgetRender(page) {
  await page.waitForFunction(
    () => !!getWidgetHost()?.shadowRoot,
    { timeout: 15000 },
  );

  await page.waitForFunction(
    () => {
      const root = getWidgetHost()?.shadowRoot;
      if (!root) return false;
      return (
        root.querySelector('[data-test-id="input-age"]') ||
        root.querySelector('[data-test-id="size-btn"]') ||
        root.querySelector('[data-test-id="measurements-table"]') ||
        root.querySelector('[data-test-id="measurement-row"]') ||
        root.querySelector('[data-test-id="no-visor-recommended-size"]') ||
        root.querySelector('[data-test-id="no-visor-container"]') ||
        root.querySelector('[data-test-id="footWidth-select-item-btn"]') ||
        root.querySelector('[data-test-id="toeShape-select-item-btn"]') ||
        root.querySelector('[data-test-id="open-sizes-footwear-picker"]') ||
        root.querySelector('[data-test-id="open-brands-footwear-picker"]') ||
        root.querySelector('[data-test-id="gift-cta"]')
      );
    },
    { timeout: 20000 },
  );
}

export async function waitForWidget(page, flow) {
  const selector =
    flow === "kids"
      ? "#vs-kid"
      : ":is(#vs-inpage, #vs-inpage-luxury, #vs-legacy-inpage)";

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

export async function waitForKidsWidgetReady(page) {
  await page.waitForFunction(
    () => {
      if (document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot)
        return true;
      return !!document.querySelector("#vs-kid")?.shadowRoot;
    },
    { timeout: 20000 },
  );
  console.log("[kids] Widget shadow root ready");
}

export async function shadowExists(page, host, selector) {
  return page.evaluate(
    ({ host, selector }) =>
      !!document.querySelector(host)?.shadowRoot?.querySelector(selector),
    { host, selector },
  );
}

export async function clickKidsWidget(page) {
  await page.waitForFunction(() =>
    findInShadow('[data-test-id="kids-inpage-button"]'),
  );
  await page.evaluate(() =>
    findInShadow('[data-test-id="kids-inpage-button"]')?.scrollIntoView({
      block: "center",
    }),
  );
  await page.waitForTimeout(500);
  const btn = page.locator('[data-test-id="kids-inpage-button"]');
  await btn.click();
}

export async function clickWidget(page, flow) {
  const accordionClicked = await page.evaluate(() => {
    const trigger = document.querySelector("h3.enf-detail-link");
    if (trigger) {
      trigger.click();
      return true;
    }
    return false;
  });
  if (accordionClicked) {
    await page.waitForTimeout(1000);
  }

  const selector =
    flow === "kids"
      ? "#vs-kid"
      : ":is(#vs-inpage, #vs-inpage-luxury, #vs-legacy-inpage)";

  await page.evaluate((sel) => {
    document.querySelector(sel)?.scrollIntoView({ block: "center" });
  }, selector);

  await page.waitForSelector(selector, { state: "visible", timeout: 15000 });

  if (flow !== "kids") {
    if (
      await page.evaluate(
        () =>
          !!document.querySelector("#vs-inpage") ||
          !!document.querySelector("#vs-inpage-luxury"),
      )
    ) {
      await page.waitForFunction(
        () => {
          const isLuxury = !!document.querySelector("#vs-inpage-luxury");
          const root = (
            document.querySelector("#vs-inpage") ||
            document.querySelector("#vs-inpage-luxury")
          )?.shadowRoot;
          return (
            !!root?.querySelector('[data-test-id="inpage-open-aoyama-btn"]') ||
            !!root?.querySelector(
              '[data-test-id="inpage-luxury-open-aoyama"]',
            ) ||
            (!isLuxury && !!root?.querySelector('[data-test-id="gift-cta"]'))
          );
        },
        { timeout: 15000 },
      );

      await page.evaluate(() => {
        const isLuxury = !!document.querySelector("#vs-inpage-luxury");
        const root = (
          document.querySelector("#vs-inpage") ||
          document.querySelector("#vs-inpage-luxury")
        )?.shadowRoot;
        const btn =
          root?.querySelector('[data-test-id="inpage-open-aoyama-btn"]') ||
          root?.querySelector('[data-test-id="inpage-luxury-open-aoyama"]') ||
          (!isLuxury && root?.querySelector('[data-test-id="gift-cta"]')) ||
          null;
        btn?.click();
      });
    } else {
      await page.locator("#vs-legacy-inpage").click({ force: true });
    }
    return;
  }

  await page.locator(selector).click({ force: true });
}

// --------------------------------------------------
// Onboarding Check
// --------------------------------------------------

export async function isOnboardingVisible(page) {
  return await page.evaluate(
    () =>
      !!getWidgetHost()?.shadowRoot?.querySelector('[data-test-id="input-age"]'),
  );
}

// --------------------------------------------------
// Status / Event Waiters
// --------------------------------------------------

export async function waitForStatus(getter, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = getter();
    if (value !== null && value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

export async function waitForEvent(eventWatcher, eventKey, timeout = 20000) {
  const hasEvent = () =>
    eventWatcher.getEvents().some((e) => e.startsWith(eventKey));

  if (hasEvent()) return;

  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (hasEvent()) return;
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(`Timed out waiting for event: ${eventKey}`);
}

export async function waitForRecommendationReady(
  eventWatcher,
  recommendationAPI,
) {
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

// --------------------------------------------------
// Kids Helper
// --------------------------------------------------

export async function kidsRetry(
  page,
  fn,
  label,
  maxAttempts = 3,
  delayMs = 500,
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fn();
      return;
    } catch (e) {
      if (attempt === maxAttempts) {
        throw new Error(
          `[kids] "${label}" failed after ${maxAttempts} attempts: ${e.message}`,
        );
      }
      console.warn(
        `[kids] "${label}" attempt ${attempt} failed: ${e.message} — retrying...`,
      );
      await page.waitForTimeout(delayMs);
    }
  }
}

// --------------------------------------------------
// Flow Runners
// --------------------------------------------------

export async function runApparelFlow(
  page,
  bodyAPI,
  eventWatcher,
  recommendationAPI,
  onboardingOpts = {},
) {
  const isNewUser = await isOnboardingVisible(page);

  if (isNewUser) {
    await completeOnboarding(page, onboardingOpts);
    await waitForRecommendationReady(eventWatcher, recommendationAPI);
    const bodyStatus = await waitForStatus(() => bodyAPI.getStatus(), 5000);
    expect(bodyStatus).toBe(200);
  }

  return isNewUser;
}

export async function runBagFlow(page) {
  console.log("[bag] Starting bag flow");

  await page.waitForFunction(
    () => !!findInShadow('[data-test-id="privacy-policy-checkbox"]'),
    { timeout: 15000 },
  );
  console.log("[bag] Privacy policy modal found");

  await page.evaluate(() => {
    const checkbox = findInShadow('[data-test-id="privacy-policy-checkbox"]');
    if (!checkbox) return;
    const root = checkbox.getRootNode();
    const linkButton = root.querySelector?.("#linkText");
    if (linkButton) linkButton.removeAttribute("id");
    checkbox.click();
  });
  console.log("[bag] Privacy policy checked");

  const nextBtn = page.locator('[data-test-id="accept-privacy-policy-btn"]');
  await expect(nextBtn).toBeEnabled({ timeout: 5000 });
  await nextBtn.click();
  console.log("[bag] Clicked accept privacy policy");

  await page.waitForTimeout(2000);

  await page.waitForFunction(
    () => !!findInShadow("button.everyday-item-btns"),
    { timeout: 20000 },
  );
  await page.evaluate(() => {
    findInShadow("button.everyday-item-btns")?.click();
  });
  console.log("[bag] Clicked budget button");

  await page.waitForFunction(() => !!findInShadow(".hidden-select"), {
    timeout: 10000,
  });

  await page.evaluate(() => {
    const select = findInShadow(".hidden-select");
    if (!select) return;
    select.value = "JPY_5000";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  console.log("[bag] Selected size option");

  return false;
}

export async function runNoVisorFlow(page, bodyAPI, onboardingOpts = {}) {
  const isNewUser = await isOnboardingVisible(page);

  if (isNewUser) {
    console.log("New user → running onboarding (no-visor)");
    await completeOnboarding(page, onboardingOpts);
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

/**
 * @param {import('@playwright/test').Page} page
 * @param {object} [footwearOpts]
 * @param {number} [footwearOpts.genderIndex=0]  0=female, 1=male
 * @param {number} [footwearOpts.brandIndex=1]   0=UA,1=Adidas,2=Asics,3=Converse,4=NB,5=Nike,6=Puma,7=Reebok,8=Vans,9=I don't know
 * @param {number} [footwearOpts.sizeIndex=17]   0=17cm, 1=17.5cm … 36=35cm (default 17→25.5cm)
 */
export async function runFootwearFlow(page, footwearOpts = {}) {
  const {
    genderIndex = 0,
    brandIndex  = 1,
    sizeIndex   = 17,
  } = footwearOpts;

  const genderValue = genderIndex === 1 ? 'male' : 'female';
  await page.waitForFunction(
    () =>
      !!getWidgetHost()?.shadowRoot?.querySelector("#vs-aoyama-main-modal"),
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

  const interact = async (action) => {
    await action();
    await page.waitForTimeout(2000);
  };

  const clickNext = () =>
    interact(() => shadowClick('[data-test-id="footwear-next-btn"]'));

  await interact(() =>
    shadowClick('[data-test-id="footWidth-select-item-btn"]'),
  );
  await clickNext();

  await page.waitForFunction(
    () =>
      (getWidgetHost()?.shadowRoot?.querySelectorAll(
        '[data-test-id="toeShape-select-item-btn"]',
      )?.length ?? 0) > 0,
    { timeout: 15000 },
  );
  await interact(() =>
    page.evaluate(() => {
      const btns = getWidgetHost()?.shadowRoot?.querySelectorAll(
        '[data-test-id="toeShape-select-item-btn"]',
      );
      if (btns?.length) btns[Math.floor(btns.length / 2)].click();
    }),
  );
  await clickNext();

  await interact(() =>
    page.evaluate((gv) => {
      const modal = getWidgetHost()?.shadowRoot?.querySelector(
        "#vs-aoyama-main-modal",
      );
      const radios = modal?.querySelectorAll(
        '[data-test-id="gender-radio-buttons"] input[type="radio"]',
      );
      if (!radios?.length) return;
      const target = [...radios].find(
        (el) => el.value.toLowerCase() === gv,
      );
      if (target) {
        target.click();
        target.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, genderValue),
  );
  await clickNext();

  await interact(() =>
    page.evaluate(() => {
      const modal = getWidgetHost()?.shadowRoot?.querySelector(
        "#vs-aoyama-main-modal",
      );
      modal
        ?.querySelector('[data-test-id="open-brands-footwear-picker"]')
        ?.click();
    }),
  );
  await page.waitForFunction(
    () =>
      !!getWidgetHost()?.shadowRoot?.querySelector(
        '[data-test-id="footwear-picker"]',
      ),
    { timeout: 5000 },
  );
  await interact(() =>
    page.evaluate((idx) => {
      const root = getWidgetHost()?.shadowRoot;
      root
        ?.querySelector(
          `[data-test-id="footwear-picker"] label[for="radioButton-${idx}"]`,
        )
        ?.click();
    }, brandIndex),
  );
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
  await clickNext();

  await interact(() =>
    shadowClick('[data-test-id="open-sizes-footwear-picker"]'),
  );
  await page.waitForFunction(
    () =>
      !!getWidgetHost()?.shadowRoot?.querySelector(
        '[data-test-id="footwear-picker"]',
      ),
    { timeout: 5000 },
  );
  await interact(() =>
    page.evaluate((idx) => {
      const root = getWidgetHost()?.shadowRoot;
      root
        ?.querySelector(
          `[data-test-id="footwear-picker"] label[for="radioButton-${idx}"]`,
        )
        ?.click();
    }, sizeIndex),
  );
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
  await clickNext();

  await interact(() =>
    page.evaluate(() => {
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
    }),
  );
  await clickNext();

  const response = await page.waitForResponse(
    (r) => r.url().includes("/shoe") && r.request().method() === "POST",
    { timeout: 10000 },
  );
  expect(response.status()).toBe(200);

  return isNewUser;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {object} [_pdc]
 * @param {object} [kidsOpts]
 * @param {number} [kidsOpts.genderIndex=0]  0=girl, 1=boy
 * @param {number} [kidsOpts.ageIndex=5]     0=3yr … 15=18yr  (index 5 → 8yr)
 * @param {string} [kidsOpts.height="120"]   cm
 * @param {string} [kidsOpts.weight="25"]    kg
 */
export async function runKidsFlow(page, _pdc, kidsOpts = {}) {
  const {
    genderIndex = 0,
    ageIndex    = 5,
    height      = "120",
    weight      = "25",
  } = kidsOpts;

  const genderValue = genderIndex === 1 ? "boy" : "girl";
  console.log("[kids] Starting Kids flow");

  await page.waitForFunction(
    () => !!findInShadow('input[name="selectKidGender"]'),
    { timeout: 30000 },
  );
  console.log("[kids] Gender radio buttons detected");

  await kidsRetry(
    page,
    async () => {
      await page.evaluate((gv) => {
        const radio = findInShadow(
          `input[name="selectKidGender"][value="${gv}"]`,
        );
        if (!radio) throw new Error(`${gv} gender radio not found`);
        radio.click();
        radio.dispatchEvent(new Event("change", { bubbles: true }));
      }, genderValue);
    },
    `click ${genderValue} gender radio`,
  );
  await page.waitForTimeout(2000);
  console.log(`[kids] Gender selected: ${genderValue}`);

  await kidsRetry(
    page,
    async () => {
      await page.evaluate(() => {
        const root =
          document.querySelector("#vs-kid-app")?.nextElementSibling
            ?.shadowRoot;
        if (!root) throw new Error("Kids shadow root not found");
        const ageSpan =
          root.querySelector("span.age-input-value") ??
          root.querySelector('[data-test-id="age-input-value"]');
        if (!ageSpan) throw new Error("Age input span not found");
        ageSpan.click();
      });
    },
    "open age selector",
  );
  await page.waitForTimeout(2000);
  console.log("[kids] Age selector opened");

  await page.waitForFunction(
    () => {
      const root =
        document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot;
      if (!root) return false;
      return [...root.querySelectorAll('input[type="radio"]')].some(
        (r) => r.name !== "selectKidGender",
      );
    },
    { timeout: 10000 },
  );

  await page.evaluate((idx) => {
    const root =
      document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot;
    if (!root) throw new Error("[kids] Shadow root not found for age selection");
    const ageRadios = [...root.querySelectorAll('input[type="radio"]')].filter(
      (r) => r.name !== "selectKidGender",
    );
    if (!ageRadios.length) throw new Error("[kids] No age radio buttons found");
    const target = ageRadios[idx] ?? ageRadios[0];
    target.click();
    target.dispatchEvent(new Event("change", { bubbles: true }));
  }, ageIndex);
  await page.waitForTimeout(2000);
  console.log(`[kids] Age selected (index ${ageIndex} → ${ageIndex + 3} yr)`);
  await page.waitForTimeout(1000);

  await page.waitForFunction(
    () => {
      const root =
        document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot;
      return !!(
        root?.querySelector(
          '[data-test-id="kids-height-input-desktop"] input',
        ) &&
        root?.querySelector('[data-test-id="kids-weight-input-desktop"] input')
      );
    },
    { timeout: 15000 },
  );

  for (const [testId, value] of [
    ["kids-height-input-desktop", String(height)],
    ["kids-weight-input-desktop", String(weight)],
  ]) {
    await page.evaluate(
      ({ testId, value }) => {
        const root =
          document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot;
        const input = root?.querySelector(`[data-test-id="${testId}"] input`);
        if (!input) throw new Error(`[kids] Input not found: ${testId}`);
        input.focus();
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
      },
      { testId, value },
    );
  }
  await page.waitForTimeout(2000);
  console.log("[kids] Height and weight filled");
  await page.waitForTimeout(1000);

  await page.evaluate(() => {
    const root =
      document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot;
    if (!root) return;
    const checkbox = root.querySelector(
      '[data-test-id="privacy-policy-checkbox"]',
    );
    if (checkbox && !checkbox.checked) {
      const label = checkbox.closest("label");
      if (label) label.removeAttribute("for");
      checkbox.click();
    }
  });
  await page.waitForTimeout(2000);
  console.log("[kids] Privacy policy accepted");
  await page.waitForTimeout(1000);

  await kidsRetry(
    page,
    async () => {
      await page.evaluate(() => {
        const root =
          document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot;
        const btn = root?.querySelector('[data-test-id="see-ideal-fit-btn"]');
        if (!btn) throw new Error("[kids] CTA button not found");
        btn.click();
      });
    },
    "click see-ideal-fit-btn",
  );
  console.log("[kids] Clicked See Your Perfect Fit");

  await page.waitForFunction(
    () => {
      const root =
        document.querySelector("#vs-kid-app")?.nextElementSibling?.shadowRoot;
      return !!root?.querySelector('[data-test-id="kids-recommended-size"]');
    },
    { timeout: 30000 },
  );
  console.log("[kids] Kids flow completed successfully");

  return true;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param eventWatcher
 * @param {object} [giftOpts]
 * @param {number} [giftOpts.genderIndex=0]    0=female, 1=male
 * @param {number} [giftOpts.ageIndex=3]       0=16-19, 1=20-25, 2=26-29, 3=30-39, 4=40-49, 5=50-59, 6=>60
 * @param {number} [giftOpts.heightIndex=3]    0=145-149cm … 10=195+cm
 * @param {number} [giftOpts.bodyTypeIndex=1]  0=<52kg, 1=52-63, 2=63-74, 3=74-84, 4=85-98, 5=>98kg
 */
export async function runGiftFlow(page, eventWatcher, giftOpts = {}) {
  const {
    genderIndex   = 0,
    ageIndex      = 3,
    heightIndex   = 3,
    bodyTypeIndex = 1,
  } = giftOpts;

  const genderValue = genderIndex === 1 ? 'male' : 'female';
  console.log("Running VS Gift flow");

  const hasGift = await page
    .waitForFunction(
      () => !!findInShadow('[data-test-id="gift-cta-section"]'),
      { timeout: 5000 },
    )
    .catch(() => false);

  if (!hasGift) {
    console.log("Gift CTA not found — skipping gift flow");
    return false;
  }

  await page.waitForFunction(
    () => !!findInShadow('[data-test-id="gift-cta"]'),
    { timeout: 15000 },
  );
  await page.evaluate(() =>
    findInShadow('[data-test-id="gift-cta"]')?.click(),
  );

  await page.waitForFunction(
    () => !!findInShadow('[data-test-id="input-age-desktop"]'),
    { timeout: 15000 },
  );
  console.log("Gift onboarding detected");
  await page.waitForTimeout(5000);

  await page.evaluate((gv) => {
    const radio = findInShadow(`input[name="selectGender"][value="${gv}"]`);
    if (!radio) throw new Error(`${gv} gender radio not found`);
    radio.click();
    radio.dispatchEvent(new Event("change", { bubbles: true }));
  }, genderValue);
  await page.waitForTimeout(2000);
  console.log(`Selected gender: ${genderValue}`);

  await page.locator('[data-test-id="input-age-desktop"]').click();
  await page.waitForFunction(
    () => !!findInShadow("#sheet")?.querySelector('span[role="radio"]'),
    { timeout: 10000 },
  );
  await page.evaluate((idx) =>
    findInShadow("#sheet")?.querySelectorAll('span[role="radio"]')[idx]?.click(),
  , ageIndex);
  await page.waitForFunction(
    () => !findInShadow("#sheet")?.querySelector('span[role="radio"]'),
    { timeout: 8000 },
  );
  await page.waitForTimeout(2000);
  console.log(`Selected age (index ${ageIndex})`);

  await page.waitForTimeout(2000);
  await page.locator('[data-test-id="input-height-desktop"]').click();
  await page.waitForFunction(
    () => !!findInShadow("#sheet")?.querySelector('span[role="radio"]'),
    { timeout: 10000 },
  );
  await page.evaluate((idx) =>
    findInShadow("#sheet")?.querySelectorAll('span[role="radio"]')[idx]?.click(),
  , heightIndex);
  await page.waitForFunction(
    () => !findInShadow("#sheet")?.querySelector('span[role="radio"]'),
    { timeout: 8000 },
  );
  await page.waitForFunction(
    () => {
      const el = findInShadow('[data-test-id="input-height-desktop"]');
      return el && !/^\s*-\s*$/.test(el.textContent ?? "");
    },
    { timeout: 8000 },
  );
  await page.waitForTimeout(2000);
  console.log(`Selected height (index ${heightIndex})`);

  await page.waitForTimeout(2000);
  await page.locator('[data-test-id="input-body-type"]').click();
  const bodySheet = page.locator('[data-test-id="sheetTestId"]');
  await expect(bodySheet).toBeVisible({ timeout: 10000 });
  await bodySheet.locator('[data-test-id="gridItemTestId"]').nth(bodyTypeIndex).click();
  await expect(bodySheet).toBeHidden({ timeout: 8000 });
  await page.waitForTimeout(2000);
  console.log(`Selected body type (index ${bodyTypeIndex})`);

  const privacyCheckbox = page.locator(
    '[data-test-id="privacy-policy-checkbox"]',
  );
  if (await privacyCheckbox.isVisible()) {
    await privacyCheckbox.click();
    await page.waitForTimeout(2000);
    console.log("Accepted privacy policy");
  }

  const seeIdealFitBtn = page.locator('[data-test-id="see-ideal-fit-btn"]');
  await expect(seeIdealFitBtn).toBeEnabled({ timeout: 8000 });
  await seeIdealFitBtn.click();
  console.log("Clicked see ideal fit button");

  await waitForEvent(eventWatcher, "user-opened-panel-rec::gift", 20000);

  const giftMissing = await verifyEvents(
    page,
    () => eventWatcher.getEvents(),
    expectedEvents.strict.gift,
  );
  if (giftMissing.length > 0) {
    const error = new Error(`Gift missing events: ${giftMissing.join(", ")}`);
    error.missingEvents = giftMissing;
    throw error;
  }

  console.log("Validating gift refresh behavior");
  eventWatcher.setPhase("gift-refresh");
  eventWatcher.reset();

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForWidget(page, "apparel");
  await page.waitForTimeout(2000);
  await clickWidget(page, "apparel");

  await page.waitForFunction(
    () => !!findInShadow('[data-test-id="gift-cta"]'),
    { timeout: 20000 },
  );
  await page.evaluate(() =>
    findInShadow('[data-test-id="gift-cta"]')?.click(),
  );

  await waitForEvent(eventWatcher, "user-opened-panel-rec::gift", 20000);
  console.log("Gift refresh: recommendation visible");

  const refreshMissing = await verifyEvents(
    page,
    () => eventWatcher.getEvents(),
    expectedEvents.refresh.gift,
  );
  if (refreshMissing.length > 0) {
    const error = new Error(
      `Gift refresh missing events: ${refreshMissing.join(", ")}`,
    );
    error.missingEvents = refreshMissing;
    throw error;
  }

  return true;
}

// --------------------------------------------------
// Validators
// --------------------------------------------------

export async function validateCoreEvents(page, eventWatcher, flow) {
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

export async function validateRefresh(
  page,
  eventWatcher,
  recommendationAPI,
  flow,
) {
  if (flow === "kids") {
    eventWatcher.reset();
    eventWatcher.setPhase("refresh");

    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForWidget(page, "kids");
    await clickKidsWidget(page);
    await page.waitForTimeout(1000);
    console.log("Waiting for kids recommendation after refresh");
    await waitForEvent(
      eventWatcher,
      "user-selected-size-kids-rec::kids",
      15000,
    );

    const failures = await verifyEvents(
      page,
      () => eventWatcher.getEvents(),
      expectedEvents.refresh.kids,
    );
    if (failures.length > 0) {
      const error = new Error(
        `Refresh missing events: ${failures.join(", ")}`,
      );
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
    await page.waitForTimeout(1500);

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

    if (flow === "footwear") {
      await waitForEvent(eventWatcher, "user-selected-size::inpage", 10000);
    }
  }

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

export function validateStrictDuplicates(eventWatcher) {
  const counts = eventWatcher.getCounts();
  const failures = [];

  const baselineKeys = [
    "user-saw-product::integration",
    "user-saw-widget-button::integration",
    "user-opened-widget::integration",
  ];
  baselineKeys.forEach((key) => {
    if ((counts[key] || 0) > 1) failures.push(`${key} x${counts[key]}`);
  });

  const recCount = counts["user-got-size-recommendation::integration"] || 0;
  if (recCount > 1)
    failures.push(`user-got-size-recommendation::integration x${recCount}`);

  const sizeIntegration = counts["user-selected-size::integration"] || 0;
  const sizeInpage = counts["user-selected-size::inpage"] || 0;
  if (sizeIntegration > 1)
    failures.push(`user-selected-size::integration x${sizeIntegration}`);
  if (sizeInpage > 1)
    failures.push(`user-selected-size::inpage x${sizeInpage}`);

  if (failures.length > 0) {
    throw new Error(`Strict duplicate events detected: ${failures.join(", ")}`);
  }
}

// --------------------------------------------------
// Full Flow Runner (used by agent run_inpage_test tool)
// --------------------------------------------------

/**
 * Run the complete inpage test flow for the current page.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ pdc, eventWatcher, recommendationAPI, bodyAPI }} watchers - already-initialized watchers
 * @param {{ phase?: string, url?: string, BOT_PROTECTED_DOMAINS?: string[] }} options
 * @returns {Promise<{ status: 'passed'|'skipped'|'failed', flow?: string, store?: string, productType?: string, isNewUser?: boolean, reason?: string, error?: string }>}
 */
export async function runInpageFlow(
  page,
  { pdc, eventWatcher, recommendationAPI, bodyAPI },
  { phase = "full", url = null, BOT_PROTECTED_DOMAINS: botDomains = [], giftOpts = {} } = {},
) {
  // 1. Wait for PDC
  await waitForPDC(pdc);

  // 2. Fallback: if PDC missed but widget is already rendered, treat as valid
  if (pdc.validProduct !== true) {
    const widgetRendered = await page.evaluate(
      () =>
        !!(
          document.querySelector("#vs-inpage")?.shadowRoot?.children.length ||
          document.querySelector("#vs-inpage-luxury")?.shadowRoot
            ?.children.length ||
          document.querySelector("#vs-legacy-inpage")
        ),
    );
    if (widgetRendered) {
      console.log("PDC missed but widget is rendered — treating as valid");
      pdc.validProduct = true;
    }
  }

  console.log(
    "PDC resolved:",
    pdc.store,
    pdc.productType,
    "valid:",
    pdc.validProduct,
  );

  // 3. Bag path
  if (isBagProduct(pdc)) {
    console.log("[bag] Bag product detected:", pdc.productType);
    if (pdc.validProduct !== true) {
      return { status: "skipped", flow: "bag", store: pdc.store, reason: "Invalid bag product" };
    }

    await page.waitForFunction(
      () => {
        const root =
          document.querySelector("#vs-inpage")?.shadowRoot ||
          document.querySelector("#vs-inpage-luxury")?.shadowRoot;
        return (
          !!root?.querySelector('[data-test-id="inpage-open-aoyama-btn"]') ||
          !!root?.querySelector('[data-test-id="inpage-luxury-open-aoyama"]')
        );
      },
      { timeout: 15000 },
    );

    await page.evaluate(() => {
      const root =
        document.querySelector("#vs-inpage")?.shadowRoot ||
        document.querySelector("#vs-inpage-luxury")?.shadowRoot;
      const btn =
        root?.querySelector('[data-test-id="inpage-open-aoyama-btn"]') ||
        root?.querySelector('[data-test-id="inpage-luxury-open-aoyama"]');
      btn?.click();
    });
    console.log("[bag] Clicked inpage button");

    if (phase === "widget") {
      return { status: "passed", flow: "bag", phase, store: pdc.store };
    }

    await page.waitForFunction(() => !!getWidgetHost()?.shadowRoot, {
      timeout: 15000,
    });
    await runBagFlow(page);
    return { status: "passed", flow: "bag", store: pdc.store, productType: pdc.productType };
  }

  // 4. Bot protection + skip check
  const isBotProtectedUrl = (() => {
    if (!url) return false;
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, "");
      return botDomains.some(
        (d) => hostname === d || hostname.endsWith(`.${d}`),
      );
    } catch {
      return false;
    }
  })();

  const skipReason =
    getSkipReason(pdc) ??
    (isBotProtectedUrl
      ? "Bot-protected store — cannot be automated"
      : null) ??
    (pdc.validProduct !== true
      ? "No valid Virtusize product detected on this PDP"
      : null);

  if (skipReason) {
    console.log("SKIPPED:", skipReason);
    return { status: "skipped", store: pdc.store, productType: pdc.productType, reason: skipReason };
  }

  // 5. Detect flow
  const flow = detectFlow(pdc);
  console.log("Flow:", flow);

  // 6. Wait for widget element in DOM
  await page.waitForFunction(
    () =>
      document.querySelector("#vs-placeholder-cart") ||
      document.querySelector("#vs-inpage") ||
      document.querySelector("#vs-inpage-luxury") ||
      document.querySelector("#vs-legacy-inpage") ||
      document.querySelector("#vs-kid"),
    { timeout: 30000 },
  );

  // 7. Open widget
  if (flow === "kids") {
    await clickKidsWidget(page);
    await waitForKidsWidgetReady(page);
  } else {
    await clickWidget(page, flow);
    await waitForWidgetRender(page);
  }

  if (phase === "widget") {
    return { status: "passed", flow, phase, store: pdc.store, productType: pdc.productType };
  }

  // 8. Run onboarding / flow
  let isNewUser = false;
  if (flow === "apparel")
    isNewUser = await runApparelFlow(page, bodyAPI, eventWatcher, recommendationAPI);
  if (flow === "footwear") isNewUser = await runFootwearFlow(page);
  if (flow === "kids") isNewUser = await runKidsFlow(page, pdc);
  if (flow === "noVisor") isNewUser = await runNoVisorFlow(page, bodyAPI);

  if (phase === "onboarding") {
    return { status: "passed", flow, phase, store: pdc.store, productType: pdc.productType, isNewUser };
  }

  // 9. Full: recommendation + size + wardrobe + event validation + refresh + gift
  if (flow === "apparel") {
    await validateRecommendation(eventWatcher);
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
      return host?.shadowRoot?.querySelector(
        '[data-test-id="no-visor-recommended-size"]',
      );
    });
  }

  await validateCoreEvents(page, eventWatcher, flow);
  await page.waitForTimeout(3000);
  await validateRefresh(page, eventWatcher, recommendationAPI, flow);

  const isLuxuryInpage = await page.evaluate(
    () => !!document.querySelector("#vs-inpage-luxury"),
  );

  if (flow === "apparel" && !isLuxuryInpage) {
    await page.waitForTimeout(10000);
    eventWatcher.setPhase("gift");
    eventWatcher.reset();
    await runGiftFlow(page, eventWatcher, giftOpts);
  }

  return {
    status: "passed",
    flow,
    store: pdc.store,
    productType: pdc.productType,
    isNewUser,
  };
}
