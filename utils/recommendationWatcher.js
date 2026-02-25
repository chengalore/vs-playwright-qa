export function startRecommendationWatcher(page) {
  let recommendationStatus = null;
  let recommendationPayload = null;

  page.on("response", async (response) => {
    const url = response.url();

    if (url.includes("size-recommendation.virtusize")) {
      recommendationStatus = response.status();

      try {
        recommendationPayload = await response.json();
      } catch {
        recommendationPayload = null;
      }

      console.log("Recommendation API Status:", recommendationStatus);
    }
  });

  return {
    getStatus: () => recommendationStatus,
    getPayload: () => recommendationPayload,
  };
}
