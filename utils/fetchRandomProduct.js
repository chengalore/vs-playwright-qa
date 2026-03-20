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
 * Resolves the test URL from environment variables.
 *
 * Priority:
 *   1. TEST_URL — use as-is, skips the Random Product API
 *   2. Any filter env vars — call the Random Product API (already returns valid products)
 *   3. No store_id/api_key — return fallbackUrl
 */
export async function resolveTestUrl(fallbackUrl) {
  if (process.env.TEST_URL) return process.env.TEST_URL;

  const parseBool = (val) =>
    val === undefined || val === "" ? undefined : val === "true";

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

  return fetchRandomProduct(apiParams);
}
