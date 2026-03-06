async function waitForRecommendation(eventWatcher, timeout = 10000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const events = eventWatcher.getEvents();

    if (events.some((e) => e.startsWith("user-got-size-recommendation"))) {
      return true;
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error("Recommendation event not detected");
}

export async function validateRecommendation(eventWatcher) {
  console.log("Validating recommendation result...");
  await waitForRecommendation(eventWatcher);
}
