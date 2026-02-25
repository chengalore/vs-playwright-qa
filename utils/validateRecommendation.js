export async function validateRecommendation(
  page,
  firedEvents,
  recommendationAPI,
  isNewUser
) {
  console.log("Validating recommendation result...");

  // Wait until recommendation UI renders inside the shadow DOM
  await page.waitForFunction(
    () => {
      const host =
        document.querySelector("#router-view-wrapper") ||
        document.querySelector("#vs-aoyama")?.nextElementSibling;

      if (!host?.shadowRoot) return false;

      const root = host.shadowRoot;

      return (
        root.querySelector('[data-test-id="size-btn"]') ||
        root.querySelector('[data-test-id="no-visor-container"]') ||
        root.querySelector('[data-test-id="body-error-screen"]')
      );
    },
    { timeout: 20000 }
  );

  // Fail early if error screen is rendered
  const hasErrorScreen = await page.evaluate(() => {
    const host =
      document.querySelector("#router-view-wrapper") ||
      document.querySelector("#vs-aoyama")?.nextElementSibling;

    return !!host?.shadowRoot?.querySelector(
      '[data-test-id="body-error-screen"]'
    );
  });

  if (hasErrorScreen) {
    throw new Error("Recommendation failed: BodyDataErrorScreen rendered.");
  }

  console.log("Recommendation screen detected.");

  // Wait for recommendation API watcher to capture response
  let apiStatus = null;
  const start = Date.now();
  const maxWait = 10000;

  while (Date.now() - start < maxWait) {
    apiStatus = recommendationAPI.getStatus();
    if (apiStatus !== null) break;
    await page.waitForTimeout(200);
  }

  if (apiStatus !== 200) {
    throw new Error(
      `Recommendation API did not return 200. Status: ${apiStatus}`
    );
  }

  console.log("Recommendation API returned 200.");

  // Event validation
  if (isNewUser && !firedEvents.includes("user-created-silhouette")) {
    throw new Error("Missing event: user-created-silhouette");
  }

  if (!firedEvents.includes("user-got-size-recommendation")) {
    throw new Error("Missing event: user-got-size-recommendation");
  }

  console.log("Recommendation events validated.");
}
