export function startShoeRecommendationWatcher(page) {
  let status = null;

  page.on("response", (response) => {
    const url = response.url();
    const method = response.request().method();

    if (url.includes("size-recommendation.virtusize.jp/shoe") && method === "POST") {
      status = response.status();
      console.log("Shoe Recommendation API Status:", status);
    }
  });

  return {
    getStatus: () => status,
  };
}
