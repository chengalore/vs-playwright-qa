export async function selectSizeIfMultiple(page, firedEvents) {
  const sizeCount = await page.evaluate(() => {
    const host = document.querySelector("#router-view-wrapper");
    const root = host?.shadowRoot;
    if (!root) return 0;

    return root.querySelectorAll('[data-test-id="size-btn"]').length;
  });

  console.log("Detected size count:", sizeCount);

  if (sizeCount > 1) {
    await page.evaluate(() => {
      const host = document.querySelector("#router-view-wrapper");
      const root = host?.shadowRoot;
      const sizes = root?.querySelectorAll('[data-test-id="size-btn"]');
      sizes?.[0]?.click();
    });

    await page.waitForTimeout(1500);

    if (!firedEvents.some((e) => e.startsWith("user-selected-size"))) {
      throw new Error("Size was clicked but user-selected-size did not fire.");
    }

    console.log("Size selected successfully.");
  } else {
    console.log("Single size — no selection needed.");
  }
}
