export async function blockMarketingScripts(page) {
  await page.route("**/*", async (route) => {
    const url = route.request().url().toLowerCase();

    const blocked = [
      "worldshopping",
      "zigzag-global",
      "zigzagcdn",
      "buyee",
      "karte.io",
      "karte-user",
      "popupsmart",
      "wisepops",
      "privy",
      "mailchimp",
    ];

    if (blocked.some((k) => url.includes(k))) {
      console.log("Blocked marketing script:", url);
      return route.abort();
    }

    return route.continue();
  });
}
