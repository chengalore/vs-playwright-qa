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

const RANDOM_PRODUCT_API =
  "https://dcai264p3l.execute-api.ap-northeast-1.amazonaws.com/prod/random_product";

// Store name → store_id
export const STORE_ALIASES = {
  acne: 54,
  adidas: 821,
  adidas_japan: 821,
  adidas_korea: 910,
  agnes_b: 800,
  allsaints: 850,
  allsaints_korea: 850,
  ameri: 885,
  ameri_vintage: 885,
  and_mall: 644,
  andar: 878,
  andar_japan: 878,
  andar_korea: 902,
  andar_singapore: 916,
  another_address: 811,
  aoure: 813,
  asics: 845,
  asics_japan: 845,
  azul: 700,
  azul_by_moussy: 700,
  banana_republic: 888,
  barbour: 882,
  barneys: 731,
  barneys_japan: 731,
  beams: 792,
  bottega: 914,
  bottega_veneta: 914,
  bottega_veneta_japan: 914,
  bottega_veneta_korea: 915,
  brooks_brothers: 730,
  brooks_brothers_korea: 905,
  bshop: 768,
  buyma: 561,
  by_malene_birger: 490,
  callawaygolf: 837,
  callaway: 837,
  camilla_and_marc: 814,
  celford: 696,
  classico: 895,
  classico_global: 895,
  classico_taiwan: 894,
  coen: 777,
  cox: 687,
  denimlife: 682,
  dinos: 64,
  edwin: 770,
  emmi: 786,
  estnation: 442,
  fashion_square: 757,
  felissimo: 851,
  fl_sportswear: 854,
  flandre: 294,
  frans_boone: 122,
  fray_i_d: 693,
  furfur: 822,
  gap: 890,
  gap_japan: 890,
  gelato_pique: 760,
  gelato: 760,
  grace_continental: 745,
  hankyu: 502,
  hankyu_hanshin: 502,
  hankyu_mens: 543,
  id_look: 710,
  jamie_kay: 897,
  johnbull: 714,
  levi: 771,
  levi_japan: 771,
  lily_brown: 740,
  llbean: 801,
  lumine: 169,
  makes: 783,
  marui: 535,
  miesrohe: 812,
  milaowen: 694,
  natulan: 889,
  nagaileben: 781,
  no_man_walks_alone: 539,
  nmwa: 539,
  nudie: 133,
  nudie_jeans: 133,
  nugu: 880,
  onward: 761,
  paul_smith: 802,
  poppy: 901,
  punyus: 121,
  ragtag: 135,
  ralph_lauren: 785,
  rl: 785,
  ralph_lauren_australia: 804,
  ralph_lauren_china: 830,
  ralph_lauren_korea: 829,
  ralph_lauren_singapore: 849,
  ralph_lauren_taiwan: 896,
  ralph_lauren_uk: 903,
  reebok: 892,
  reebok_korea: 892,
  re_edit: 810,
  retouch: 911,
  restir: 610,
  safari_lounge: 690,
  sanyo: 861,
  sanyo_online_store: 861,
  seilin: 762,
  seilin_online_shop: 762,
  shel_tter: 697,
  sixpad: 886,
  snkrdunk: 915,
  snidel: 695,
  standard_california: 713,
  stancal: 713,
  strasburgo: 452,
  strasburgo_outlet: 799,
  style_deli: 136,
  styling: 823,
  studio_nicholson: 908,
  taion: 789,
  taion_wear: 789,
  top_floor: 775,
  ua: 805,
  ua_taiwan: 473,
  under_armour: 805,
  underarmour: 805,
  unitedarrows: 907,
  unitedarrows_global: 907,
  world: 739,
  yohji: 306,
  yohji_global: 876,
  yohji_wildside: 826,
  yohji_yamamoto: 306,
  yosoou: 898,
  zuica: 842,
};

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

/**
 * Parse slash command text into API params.
 * Returns { url } if text is a direct URL.
 * Returns { scope?, store_id?, store_alias?, product_type_id?, gender?, exclude_kids?, phase } otherwise.
 *
 * scope='all'  → monitor all stores (dispatch inpage-monitor.yml)
 * phase        → one of widget | events | api | onboarding | full (default: full)
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
