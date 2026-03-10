/**
 * Stores that cannot be automated due to bot detection or unsupported
 * website structure. When a Slack /qa command targets one of these stores,
 * the user is notified instead of dispatching a workflow.
 *
 * Covers all aliases that resolve to a protected store, so both
 * `/qa adidas` and `/qa adidas_japan` are blocked (same store ID).
 */

export const BOT_PROTECTED_ALIASES = new Set([
  // Adidas Japan (bot detection)
  "adidas", "adidas_japan",
  // Asics Japan (bot detection)
  "asics", "asics_japan",
  // Bottega Veneta (bot detection)
  "bottega", "bottega_veneta", "bottega_veneta_japan", "bottega_veneta_korea",
  // By Malene Birger (unsupported structure)
  "by_malene_birger",
  // Ralph Lauren — all regions (bot detection)
  "ralph_lauren", "rl",
  "ralph_lauren_australia",
  "ralph_lauren_china",
  "ralph_lauren_korea",
  "ralph_lauren_singapore",
  "ralph_lauren_taiwan",
  "ralph_lauren_uk",
]);

export const BOT_PROTECTED_REASON =
  "Bot detection or unsupported website structure — please test manually.";
