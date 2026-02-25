export async function completeOnboarding(page) {
  console.log("Completing onboarding (shadow DOM)...");

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

  // Basic body data
  await fillInput("input-age", "35");
  await fillInput("input-height", "161");
  await fillInput("input-weight", "54");

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

  console.log("Onboarding finished.");
}
