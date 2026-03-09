export async function selectSizeIfMultiple(page, eventWatcher) {
  const sizeCount = await page.evaluate(() => {
    const host = document.querySelector("#router-view-wrapper");
    const root = host?.shadowRoot;
    if (!root) return 0;

    return root.querySelectorAll('[data-test-id="size-btn"]').length;
  });

  if (sizeCount <= 1) return;

  // Click second size to ensure change
  await page.evaluate(() => {
    const host = document.querySelector("#router-view-wrapper");
    const root = host?.shadowRoot;
    const sizes = root?.querySelectorAll('[data-test-id="size-btn"]');

    if (sizes && sizes.length > 1) {
      sizes[1].click();
    }
  });

  // Wait for fit-illustrator size event
  const start = Date.now();
  const timeout = 5000;
  let found = false;

  while (Date.now() - start < timeout) {
    const counts = eventWatcher.getCounts();
    const key = "user-selected-size::fit-illustrator";

    if ((counts[key] || 0) >= 1) {
      found = true;
      break;
    }

    await page.waitForTimeout(100);
  }

  if (!found) {
    throw new Error(
      "Size was clicked but user-selected-size (fit-illustrator) did not fire."
    );
  }

}
