export function startRecommendationWatcher(page) {
  let status = null;

  page.on("response", async (response) => {
    const url = response.url();

    if (url.includes("/size-recommendation")) {
      status = response.status();
      console.log("Recommendation API Status:", status);
    }
  });

  return {
    getStatus: () => status,
  };
}
