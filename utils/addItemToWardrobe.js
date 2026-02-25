export async function addItemToWardrobe(page, firedEvents) {
  console.log("Attempting to add item to wardrobe...");

  // Check if product details button exists
  const hasDetailsButton = await page.evaluate(() => {
    const host = document.querySelector("#router-view-wrapper");
    const root = host?.shadowRoot;
    if (!root) return false;

    return !!root.querySelector(
      '[data-test-id="open-product-details-sheet-btn"]'
    );
  });

  if (!hasDetailsButton) {
    console.log("Product details button not found.");
    return;
  }

  // Open product details
  await page.evaluate(() => {
    const host = document.querySelector("#router-view-wrapper");
    const root = host?.shadowRoot;
    const btn = root?.querySelector(
      '[data-test-id="open-product-details-sheet-btn"]'
    );
    btn?.click();
  });

  await page.waitForTimeout(2000);

  // Check if toggle button exists
  const hasToggleButton = await page.evaluate(() => {
    const host = document.querySelector("#router-view-wrapper");
    const root = host?.shadowRoot;
    if (!root) return false;

    return !!root.querySelector('[data-test-id="toggle-item-to-wardrobe-btn"]');
  });

  if (!hasToggleButton) {
    console.log("Toggle wardrobe button not found.");
    return;
  }

  // Click toggle
  await page.evaluate(() => {
    const host = document.querySelector("#router-view-wrapper");
    const root = host?.shadowRoot;
    const toggle = root?.querySelector(
      '[data-test-id="toggle-item-to-wardrobe-btn"]'
    );
    toggle?.click();
  });

  await page.waitForTimeout(1500);

  console.log("Item added to wardrobe successfully.");
}
