/**
 * Captures a padded screenshot of #vs-smart-table (the page-embedded size-guide
 * element some stores have, separate from the widget's shadow DOM). Expands it
 * first if it's inside a collapsed accordion, then grows the viewport as needed
 * so the diagram, size selector, and footer branding below it aren't clipped.
 */
export async function captureSmartTable(page, opts = {}) {
  const {
    type = "jpeg",
    quality = 85,
    padSide = 150,
    padTop = 150,
    padBottom = 1000, // size selector + footer branding live here
  } = opts;

  const stLoc = page.locator("#vs-smart-table").first();
  if ((await stLoc.count().catch(() => 0)) === 0) return null;

  const needsExpand = await page.evaluate(() => {
    const st = document.querySelector("#vs-smart-table");
    return st ? st.getBoundingClientRect().height === 0 : false;
  }).catch(() => false);

  if (needsExpand) {
    await page.evaluate(() => {
      const st = document.querySelector("#vs-smart-table");
      if (!st) return;
      let el = st.parentElement;
      while (el && el !== document.body) {
        const prev = el.previousElementSibling;
        if (prev && (
          prev.classList.contains("js-accodion-tab") ||
          prev.getAttribute("role") === "tab" ||
          prev.getAttribute("role") === "button" ||
          prev.hasAttribute("aria-expanded")
        )) { prev.click(); return; }
        el = el.parentElement;
      }
    }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  await stLoc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(5000); // give smart table content time to fully render

  const originalViewport = page.viewportSize();
  let stBbox = await stLoc.boundingBox().catch(() => null);
  let stBuf = null;
  let resized = false;

  if (stBbox && originalViewport) {
    const neededWidth = Math.ceil(stBbox.x + stBbox.width + padSide);
    const neededHeight = Math.ceil(stBbox.y + stBbox.height + padBottom);
    resized = neededWidth > originalViewport.width || neededHeight > originalViewport.height;
    if (resized) {
      await page.setViewportSize({
        width: Math.max(originalViewport.width, neededWidth),
        height: Math.max(originalViewport.height, neededHeight),
      }).catch(() => {});
      await page.waitForTimeout(1000);
      // Re-measure — growing the viewport can bring more of the table into view
      // and trigger additional lazy-rendered content, changing its true height.
      stBbox = await stLoc.boundingBox().catch(() => stBbox);
    }
    const clip = {
      x: Math.max(0, stBbox.x - padSide),
      y: Math.max(0, stBbox.y - padTop),
      width: stBbox.width + padSide * 2,
      height: stBbox.height + padTop + padBottom,
    };
    stBuf = await page.screenshot({ type, quality, clip, timeout: 8000 }).catch(() => null);
  } else {
    // Fallback: element screenshot if we couldn't measure the bounding box
    stBuf = await stLoc.screenshot({ type, quality, timeout: 8000 }).catch(() => null);
  }

  if (resized && originalViewport) {
    await page.setViewportSize(originalViewport).catch(() => {});
  }

  return stBuf;
}
