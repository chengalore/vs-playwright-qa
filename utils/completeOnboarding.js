/**
 * Complete the Virtusize apparel onboarding flow.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} [opts]
 * @param {number} [opts.genderIndex=0]  0 = female, 1 = male
 * @param {string} [opts.age="35"]
 * @param {string} [opts.height="161"]
 * @param {string} [opts.weight="54"]
 */
export async function completeOnboarding(page, opts = {}) {
  const {
    genderIndex = 0,
    age    = "35",
    height = "161",
    weight = "54",
  } = opts;

  // Wait until the shadow root is available
  await page.waitForFunction(
    () => {
      const host = document.querySelector("#router-view-wrapper");
      return host && host.shadowRoot;
    },
    { timeout: 20000 }
  );

  const shadowRoot = await page.evaluateHandle(() => {
    return document.querySelector("#router-view-wrapper")?.shadowRoot;
  });

  if (!shadowRoot) {
    throw new Error("Shadow root not found");
  }

  const fillInput = async (testId, value) => {
    const handle = await shadowRoot.evaluateHandle((root, id) => {
      return root.querySelector(`[data-test-id="${id}"] input`);
    }, testId);

    const input = handle.asElement();
    if (!input) {
      await handle.dispose();
      throw new Error(`Input not found: ${testId}`);
    }

    await input.fill(value);
    await input.press("Tab");
    await handle.dispose();
  };

  // Gender selection — click the radio button at genderIndex (0=female, 1=male)
  // Safe: silently skips if no radio buttons are present (returning user, no onboarding screen)
  await shadowRoot.evaluate((root, idx) => {
    const radios = root.querySelectorAll('input[type="radio"]');
    if (radios[idx]) {
      radios[idx].click();
      radios[idx].dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, genderIndex);
  await page.waitForTimeout(500);

  // Basic body data
  await fillInput("input-age", String(age));
  await page.waitForTimeout(2000);
  await fillInput("input-height", String(height));
  await page.waitForTimeout(2000);
  await fillInput("input-weight", String(weight));
  await page.waitForTimeout(2000);

  // Accept privacy policy if required
  const privacyHandle = await shadowRoot.evaluateHandle((root) =>
    root.querySelector('[data-test-id="privacy-policy-checkbox"]')
  );

  const checkbox = privacyHandle.asElement();
  if (checkbox) {
    const isChecked = await checkbox.isChecked();
    if (!isChecked) {
      await checkbox.evaluate((el) => {
        el.checked = true;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForTimeout(2000);
    }
  }

  await privacyHandle.dispose();

  // Submit onboarding
  const buttonHandle = await shadowRoot.evaluateHandle((root) =>
    root.querySelector('[data-test-id="see-ideal-fit-btn"]')
  );

  const submitButton = buttonHandle.asElement();
  if (!submitButton) {
    await buttonHandle.dispose();
    throw new Error("Submit button not found");
  }

  await submitButton.click();
  await buttonHandle.dispose();

}
