/**
 * Fetches a random product URL from the Virtusize Random Product API.
 *
 * Supported params:
 *   store_id        – numeric store ID
 *   api_key         – store API key
 *   product_type_id – numeric product type (see VS product type API)
 *   gender          – "male" | "female" | "kids" | "unisex"
 *   category        – product category string
 *   exclude_kids    – boolean, exclude kids products
 *   check_pdp       – boolean, validates the PDP is reachable (default: true)
 *   valid           – boolean, filter by product validity (default: true)
 *
 * Returns the product PDP URL string, or throws if none found.
 *
 * Environment variables:
 *   TEST_URL        – skip the API and use this URL directly
 *   STORE_ID        – numeric store ID
 *   API_KEY         – store API key
 *   PRODUCT_TYPE_ID – numeric product type ID
 *   GENDER          – "male" | "female" | "kids" | "unisex"
 *   CATEGORY        – product category string
 *   IS_NOVISOR      – "true" | "false"
 *   EXCLUDE_KIDS    – "true" | "false"
 *   VALID           – "true" | "false" (API defaults to true; set to "false" to override)
 *
 * Example QA commands:
 *   shoes          → PRODUCT_TYPE_ID=17
 *   kids           → GENDER=kids
 *   novisor        → IS_NOVISOR=true
 *   tshirt novisor → PRODUCT_TYPE_ID=2 IS_NOVISOR=true
 *   ua shoes       → STORE_ID=805 PRODUCT_TYPE_ID=17
 *   ua kids        → STORE_ID=805 GENDER=kids
 */

const RANDOM_PRODUCT_API =
  "https://dcai264p3l.execute-api.ap-northeast-1.amazonaws.com/prod/random_product";

const PRODUCT_CHECK_API =
  "https://api.virtusize.jp/a/api/v3/product/check-by-external-id";

const MAX_RETRIES = 10;

export async function fetchRandomProduct(params = {}) {
  const {
    store_id,
    api_key,
    product_type_id,
    gender,
    category,
    exclude_kids,
    check_pdp,
    valid,
  } = params;

  const query = new URLSearchParams();
  if (store_id !== undefined) query.set("store_id", String(store_id));
  if (api_key !== undefined) query.set("api_key", String(api_key));
  if (product_type_id !== undefined)
    query.set("product_type_id", String(product_type_id));
  if (gender !== undefined) query.set("gender", gender);
  if (category !== undefined) query.set("category", category);
  if (exclude_kids !== undefined)
    query.set("exclude_kids", String(exclude_kids));
  if (check_pdp !== undefined) query.set("check_pdp", String(check_pdp));
  if (valid !== undefined) query.set("valid", String(valid));

  const url = `${RANDOM_PRODUCT_API}?${query.toString()}`;
  console.log("Fetching random product:", url);

  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `fetchRandomProduct: API returned ${res.status} ${res.statusText} for ${url}${body ? ` — ${body}` : ""}`,
    );
  }

  const json = await res.json();

  // The API returns an array of product objects; pick one at random.
  const products = Array.isArray(json) ? json : [json];
  const product = products[Math.floor(Math.random() * products.length)];
  const pdpUrl = product?.url ?? product?.pdp_url;

  if (!pdpUrl) {
    throw new Error(
      `fetchRandomProduct: no URL in response — ${JSON.stringify(json)}`,
    );
  }

  console.log("Random product URL:", pdpUrl);
  return pdpUrl;
}

/**
 * Extracts the external product ID from a PDP URL.
 *
 * Strategy:
 *   1. Check common query param names (pid, id, productId, etc.)
 *   2. Fall back to the last non-empty path segment
 *
 * Examples:
 *   https://snidel.com/Form/Product/ProductDetail.aspx?shop=0&pid=SHCT212057 → SHCT212057
 *   https://www.underarmour.co.jp/f/dsg-1041508                              → dsg-1041508
 */
export function extractExternalProductId(pdpUrl) {
  try {
    const url = new URL(pdpUrl);

    const commonParams = [
      "pid", "id", "productId", "product_id",
      "itemId", "item_id", "sku", "code", "item",
    ];
    for (const param of commonParams) {
      const val = url.searchParams.get(param);
      if (val) return val;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length > 0) return segments[segments.length - 1];

    return null;
  } catch {
    return null;
  }
}

/**
 * Calls the Virtusize product check API to verify a product is valid.
 * Returns true only if the API responds with validProduct: true.
 */
async function isValidVirtusizeProduct(storeId, externalProductId) {
  try {
    const query = new URLSearchParams({
      store_id: String(storeId),
      external_product_id: externalProductId,
    });
    const res = await fetch(`${PRODUCT_CHECK_API}?${query.toString()}`);
    if (!res.ok) return false;
    const json = await res.json();
    return json?.validProduct === true;
  } catch {
    return false;
  }
}

/**
 * Resolves the test URL from environment variables.
 *
 * Priority:
 *   1. TEST_URL — use as-is, skips the Random Product API
 *   2. Any filter env vars — call the API with those filters, pre-validating
 *      each candidate via the Virtusize product check API (requires STORE_ID)
 *   3. No store_id/api_key — return fallbackUrl
 *
 * When STORE_ID is set, retries up to MAX_RETRIES times until a valid
 * Virtusize product is found, avoiding wasted browser runs on invalid pages.
 */
export async function resolveTestUrl(fallbackUrl) {
  if (process.env.TEST_URL) return process.env.TEST_URL;

  const parseBool = (val) =>
    val === undefined ? undefined : val === "true";

  const store_id = process.env.STORE_ID
    ? Number(process.env.STORE_ID)
    : undefined;
  const api_key = process.env.API_KEY || undefined;
  const product_type_id = process.env.PRODUCT_TYPE_ID
    ? Number(process.env.PRODUCT_TYPE_ID)
    : undefined;
  const gender = process.env.GENDER || undefined;
  const category = process.env.CATEGORY || undefined;
  const exclude_kids = parseBool(process.env.EXCLUDE_KIDS);
  // API defaults to valid=true server-side; only send when explicitly overriding to false
  const valid = process.env.VALID !== undefined ? parseBool(process.env.VALID) : undefined;

  // store_id or api_key is required by the random product API
  if (!store_id && !api_key) return fallbackUrl;

  const apiParams = { store_id, api_key, product_type_id, gender, category, exclude_kids, valid };

  // Without store_id we can't call the check API — skip pre-validation
  if (!store_id) return fetchRandomProduct(apiParams);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const pdpUrl = await fetchRandomProduct(apiParams);

    const externalProductId = extractExternalProductId(pdpUrl);
    if (!externalProductId) {
      console.log(`[attempt ${attempt}/${MAX_RETRIES}] Could not extract product ID from ${pdpUrl}, retrying...`);
      continue;
    }

    console.log(`[attempt ${attempt}/${MAX_RETRIES}] Checking: ${externalProductId}`);
    const isValid = await isValidVirtusizeProduct(store_id, externalProductId);

    if (isValid) {
      console.log(`[attempt ${attempt}/${MAX_RETRIES}] Valid product found — ${pdpUrl}`);
      return pdpUrl;
    }

    console.log(`[attempt ${attempt}/${MAX_RETRIES}] Not valid, retrying...`);
  }

  throw new Error(
    `resolveTestUrl: no valid Virtusize product found after ${MAX_RETRIES} attempts`,
  );
}
