export async function addItemToWardrobe(page, firedEvents) {
  console.log("Attempting to add item to wardrobe...");

  try {
    // Wait for product details button
    await page.waitForFunction(
      () => {
        const host = document.querySelector("#router-view-wrapper");
        return host?.shadowRoot?.querySelector(
          '[data-test-id="open-product-details-sheet-btn"]'
        );
      },
      { timeout: 10000 }
    );

    // Open product details
    await page.evaluate(() => {
      const host = document.querySelector("#router-view-wrapper");
      const root = host?.shadowRoot;
      root
        ?.querySelector('[data-test-id="open-product-details-sheet-btn"]')
        ?.click();
    });

    // Wait for toggle button to appear
    await page.waitForFunction(
      () => {
        const host = document.querySelector("#router-view-wrapper");
        return host?.shadowRoot?.querySelector(
          '[data-test-id="toggle-item-to-wardrobe-btn"]'
        );
      },
      { timeout: 5000 }
    );

    // Click toggle
    await page.evaluate(() => {
      const host = document.querySelector("#router-view-wrapper");
      const root = host?.shadowRoot;
      root
        ?.querySelector('[data-test-id="toggle-item-to-wardrobe-btn"]')
        ?.click();
    });

    await page.waitForTimeout(1500);

    console.log("Item added to wardrobe successfully.");
  } catch (err) {
    console.log("Wardrobe action skipped or failed:", err.message);
  }
}
