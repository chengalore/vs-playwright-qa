export async function validateRecommendation(
  page,
  eventWatcher,
  recommendationAPI,
  isNewUser
) {
  console.log("Validating recommendation result...");

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

  let apiStatus = null;
  const apiStart = Date.now();
  const apiTimeout = 10000;

  while (Date.now() - apiStart < apiTimeout) {
    apiStatus = recommendationAPI.getStatus();
    if (apiStatus !== null) break;
    await page.waitForTimeout(100);
  }

  if (apiStatus !== 200) {
    throw new Error(
      `Recommendation API did not return 200. Status: ${apiStatus}`
    );
  }

  console.log("Recommendation API returned 200.");

  const eventStart = Date.now();
  const eventTimeout = 5000;
  let foundRecommendation = false;

  while (Date.now() - eventStart < eventTimeout) {
    const events = eventWatcher.getEvents();

    if (events.includes("user-got-size-recommendation")) {
      foundRecommendation = true;
      break;
    }

    await page.waitForTimeout(100);
  }

  if (!foundRecommendation) {
    throw new Error("Missing event: user-got-size-recommendation");
  }

  if (isNewUser) {
    const events = eventWatcher.getEvents();

    if (!events.includes("user-created-silhouette")) {
      throw new Error("Missing event: user-created-silhouette");
    }
  }

  console.log("Recommendation events validated.");
}
