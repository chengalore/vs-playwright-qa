/**
 * Parses a /qa_inpage slash command argument into Random Product API params.
 *
 * Usage:
 *   const params = parseSlashCommand("ua shoes");
 *   // → { store_id: 805, product_type_id: 17, valid: true, check_pdp: true }
 *
 *   const params = parseSlashCommand("https://store.com/product");
 *   // → { testUrl: "https://store.com/product" }
 */

// --------------------------------------------------
// Store aliases  →  store_id
// Add new stores here. Normalize keys: lowercase, no spaces/underscores/dashes.
// --------------------------------------------------
const STORE_ALIASES = {
  // Under Armour
  ua: 805,
  underarmour: 805,
  underarmourjapan: 805,

  // Gap Japan — fill in store_id when known
  // gapjapan: ???,
  // gap: ???,
};

// --------------------------------------------------
// Product type aliases  →  product_type_id
// --------------------------------------------------
const PRODUCT_TYPE_ALIASES = {
  shoe: 17,
  shoes: 17,
  footwear: 17,
  tshirt: 2,
  tshirts: 2,
  top: 2,
  tops: 2,
  pants: 4,
  pant: 4,
  bottoms: 4,
  dress: 6,
  dresses: 6,
  jacket: 7,
  jackets: 7,
  coat: 7,
  coats: 7,
  skirt: 8,
  skirts: 8,
  shorts: 10,
  short: 10,
  jumpsuit: 11,
  jumpsuits: 11,
  sweater: 13,
  sweaters: 13,
  hoodie: 13,
  hoodies: 13,
};

// --------------------------------------------------
// Gender aliases
// --------------------------------------------------
const GENDER_ALIASES = {
  kids: "kids",
  kid: "kids",
  children: "kids",
  child: "kids",
  boys: "kids",
  girls: "kids",
  male: "male",
  men: "male",
  man: "male",
  female: "female",
  women: "female",
  woman: "female",
  unisex: "unisex",
};

// --------------------------------------------------
// No-visor aliases
// --------------------------------------------------
const NOVISOR_TOKENS = new Set([
  "novisor",
  "nonvisor",
  "novisor",
  "novizor",
]);

// --------------------------------------------------
// Normalise a single token: lowercase, strip punctuation/spaces
// --------------------------------------------------
function normalise(str) {
  return str.toLowerCase().replace(/[\s_\-]/g, "");
}

// --------------------------------------------------
// Main parser
// --------------------------------------------------
export function parseSlashCommand(input = "") {
  const trimmed = input.trim();

  // 1. Direct URL — pass through as TEST_URL
  if (trimmed.startsWith("http")) {
    return { testUrl: trimmed };
  }

  // 2. Tokenise: split on whitespace, normalise each token
  const tokens = trimmed.split(/\s+/).map(normalise).filter(Boolean);

  const params = {
    valid: true,
    check_pdp: true,
  };

  const unmatched = [];

  for (const token of tokens) {
    // Store alias
    if (STORE_ALIASES[token] !== undefined) {
      params.store_id = STORE_ALIASES[token];
      continue;
    }

    // Product type alias
    if (PRODUCT_TYPE_ALIASES[token] !== undefined) {
      params.product_type_id = PRODUCT_TYPE_ALIASES[token];
      continue;
    }

    // Gender alias
    if (GENDER_ALIASES[token] !== undefined) {
      params.gender = GENDER_ALIASES[token];
      continue;
    }

    // No-visor flag
    if (NOVISOR_TOKENS.has(token)) {
      params.is_novisor = true;
      continue;
    }

    unmatched.push(token);
  }

  if (unmatched.length > 0) {
    console.warn(`parseSlashCommand: unrecognised tokens: ${unmatched.join(", ")}`);
  }

  return params;
}

// --------------------------------------------------
// Build the Random Product API URL from parsed params
// --------------------------------------------------
const RANDOM_PRODUCT_API =
  "https://dcai264p3l.execute-api.ap-northeast-1.amazonaws.com/prod/random_product";

export function buildRandomProductUrl(params) {
  const query = new URLSearchParams();
  if (params.store_id !== undefined) query.set("store_id", String(params.store_id));
  if (params.api_key !== undefined) query.set("api_key", String(params.api_key));
  if (params.product_type_id !== undefined) query.set("product_type_id", String(params.product_type_id));
  if (params.gender !== undefined) query.set("gender", params.gender);
  if (params.category !== undefined) query.set("category", params.category);
  if (params.exclude_kids !== undefined) query.set("exclude_kids", String(params.exclude_kids));
  if (params.check_pdp !== undefined) query.set("check_pdp", String(params.check_pdp));
  if (params.valid !== undefined) query.set("valid", String(params.valid));
  return `${RANDOM_PRODUCT_API}?${query.toString()}`;
}
