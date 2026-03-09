/**
 * Fetches a random valid product URL from the Virtusize Random Product API.
 *
 * Required (one of):
 *   store_id  – numeric store ID
 *   api_key   – store API key
 *
 * Optional filters:
 *   product_type_id – numeric product type (see VS product type API)
 *   gender          – "male" | "female" | "kids" | "unisex"
 *   category        – product category string
 *   is_novisor      – boolean, filter for no-visor products
 *   exclude_kids    – boolean, exclude kids products
 *   check_pdp       – boolean (default true), validates the PDP is reachable
 *   valid           – boolean, filter by product validity
 *
 * Returns the product PDP URL string, or throws if none found.
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
    is_novisor,
    exclude_kids,
    check_pdp,
    valid,
  } = params;

  if (!store_id && !api_key) {
    throw new Error(
      "fetchRandomProduct: either store_id or api_key is required",
    );
  }

  const query = new URLSearchParams();
  if (store_id !== undefined) query.set("store_id", String(store_id));
  if (api_key !== undefined) query.set("api_key", String(api_key));
  if (product_type_id !== undefined)
    query.set("product_type_id", String(product_type_id));
  if (gender !== undefined) query.set("gender", gender);
  if (category !== undefined) query.set("category", category);
  if (is_novisor !== undefined) query.set("is_novisor", String(is_novisor));
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
      `fetchRandomProduct: API returned ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`,
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
 * Resolves the test URL from env vars.
 *
 * Priority:
 *   1. TEST_URL        — use as-is (existing behaviour)
 *   2. STORE_ID / API_KEY — call the random product API
 *   3. fallback        — use the provided default URL
 */
export async function resolveTestUrl(fallbackUrl) {
  if (process.env.TEST_URL) return process.env.TEST_URL;

  const store_id = process.env.STORE_ID
    ? Number(process.env.STORE_ID)
    : undefined;
  const api_key = process.env.API_KEY || undefined;

  if (store_id || api_key) {
    return fetchRandomProduct({
      store_id,
      api_key,
      gender: process.env.GENDER || undefined,
      product_type_id: process.env.PRODUCT_TYPE_ID
        ? Number(process.env.PRODUCT_TYPE_ID)
        : undefined,
      category: process.env.CATEGORY || undefined,
      is_novisor: process.env.IS_NOVISOR !== undefined
        ? process.env.IS_NOVISOR === "true"
        : undefined,
      exclude_kids: process.env.EXCLUDE_KIDS !== undefined
        ? process.env.EXCLUDE_KIDS === "true"
        : undefined,
      valid: process.env.VALID !== undefined
        ? process.env.VALID === "true"
        : undefined,
    });
  }

  return fallbackUrl;
}
