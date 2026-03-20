/**
 * Parses a /qa_inpage Slack slash command text into Random Product API params.
 *
 * Supported keyword formats (space-separated, any order):
 *   <url>              – direct PDP URL, skips API entirely
 *   <store>            – store alias (see STORE_ALIASES)
 *   <product_type>     – product type alias (see PRODUCT_TYPE_ALIASES)
 *   male/female/kids/unisex – gender filter
 *   exclude_kids       – exclude kids products
 *
 * Examples:
 *   ua shoes           → store_id=805, product_type_id=17
 *   kids               → gender=kids
 *   adidas tshirt      → store_id=821, product_type_id=4
 *   ralph_lauren coat  → store_id=785, product_type_id=14
 */

import { STORE_ALIASES } from "../config/stores.js";

const RANDOM_PRODUCT_API =
  process.env.RANDOM_PRODUCT_API_URL ||
  "https://dcai264p3l.execute-api.ap-northeast-1.amazonaws.com/prod/random_product";

export { STORE_ALIASES };

// Product type keyword → product_type_id
const PRODUCT_TYPE_ALIASES = {
  dress: 1,
  shirt: 2,
  sweater: 3,
  knit: 3,
  tshirt: 4,
  "t-shirt": 4,
  tee: 4,
  pants: 5,
  trousers: 5,
  panties: 6,
  underwear: 6,
  skirt: 7,
  jacket: 8,
  strapless: 11,
  top: 12,
  shorts: 13,
  coat: 14,
  aline: 15,
  "a-line": 15,
  tunic: 20,
  glasses: 21,
  eyewear: 21,
  bag: 18,
  clutch: 19,
  wallet: 25,
  shoe: 17,
  shoes: 17,
  sneaker: 17,
  sneakers: 17,
  footwear: 17,
};

// Gender keyword → API value
const GENDER_ALIASES = {
  male: "male",
  men: "male",
  mens: "male",
  female: "female",
  women: "female",
  womens: "female",
  kids: "kids",
  kid: "kids",
  children: "kids",
  unisex: "unisex",
};

// Phase keywords for TEST_PHASE
const PHASES = new Set(['widget', 'events', 'api', 'onboarding', 'full']);

// Browser keywords
const BROWSERS = new Set(['chromium', 'firefox', 'webkit']);

/**
 * Parse slash command text into API params.
 * Returns { url } if text is a direct URL.
 * Returns { scope?, store_id?, store_alias?, product_type_id?, gender?, exclude_kids?, phase } otherwise.
 *
 * scope='all'  → monitor all stores (dispatch inpage-monitor.yml)
 * phase        → one of widget | events | api | onboarding | full (default: full)
 * browser      → one of chromium | firefox | webkit (default: chromium)
 */
export function parseSlashCommand(text) {
  const trimmed = (text || "").trim();

  if (!trimmed) return {};

  // Direct URL
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return { url: trimmed };
  }

  const tokens = trimmed.toLowerCase().split(/\s+/);
  const params = {};

  // "all" scope: monitor every store
  if (tokens[0] === "all") {
    params.scope = "all";
    tokens.shift();
  }

  for (const token of tokens) {
    if (PHASES.has(token)) {
      params.phase = token;
    } else if (STORE_ALIASES[token] !== undefined) {
      params.store_id = STORE_ALIASES[token];
      params.store_alias = token;
    } else if (PRODUCT_TYPE_ALIASES[token] !== undefined) {
      params.product_type_id = PRODUCT_TYPE_ALIASES[token];
    } else if (GENDER_ALIASES[token] !== undefined) {
      params.gender = GENDER_ALIASES[token];
    } else if (token === "exclude_kids" || token === "excludekids") {
      params.exclude_kids = true;
    } else if (BROWSERS.has(token)) {
      params.browser = token;
    }
    // unknown tokens are ignored
  }

  if (!params.phase) params.phase = "full";

  return params;
}

/**
 * Resolve slash command text to a PDP URL.
 * - Direct URL → returned as-is
 * - Keywords → call Random Product API, return resolved URL
 * - No store/api_key → return null (API requires at least one)
 */
export async function resolveSlashCommandUrl(text) {
  const parsed = parseSlashCommand(text);

  if (parsed.url) return parsed.url;

  const { store_id, product_type_id, gender, exclude_kids } = parsed;

  if (!store_id) return null;

  const query = new URLSearchParams();
  query.set("store_id", String(store_id));
  if (product_type_id !== undefined) query.set("product_type_id", String(product_type_id));
  if (gender !== undefined) query.set("gender", gender);
  if (exclude_kids !== undefined) query.set("exclude_kids", String(exclude_kids));

  const apiUrl = `${RANDOM_PRODUCT_API}?${query.toString()}`;
  console.log("Resolving random product:", apiUrl);

  const res = await fetch(apiUrl);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Random Product API ${res.status}: ${body}`);
  }

  const json = await res.json();
  const products = Array.isArray(json) ? json : [json];
  const product = products[Math.floor(Math.random() * products.length)];
  const pdpUrl = product?.url ?? product?.pdp_url;

  if (!pdpUrl) throw new Error(`No URL in response: ${JSON.stringify(json)}`);

  console.log("Resolved URL:", pdpUrl);
  return pdpUrl;
}
