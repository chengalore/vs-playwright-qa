/**
 * Single source of truth for all store aliases and IDs.
 *
 * Flags:
 *   monitor:      true  → included in the inpage monitor run
 *   botProtected: true  → bot detection / unsupported structure; test marks as bot_protected
 *   luxury:       true  → uses #vs-inpage-luxury instead of #vs-inpage
 *
 * Shorthands (e.g. `ua`, `gelato`, `levi`) have no flags — they exist only for
 * slash command convenience and resolve to the same store ID as the canonical alias.
 *
 * To add or remove a store, edit this file only.
 * MONITOR_STORES, BOT_PROTECTED_ALIASES, and STORE_ALIASES are all derived below.
 */
export const STORES = {
  // ── A ────────────────────────────────────────────────────────────────
  acne: { id: 54 },
  adidas: { id: 821, botProtected: true },
  adidas_japan: { id: 821, botProtected: true },
  adidas_korea: { id: 910, botProtected: true },
  agnes_b: { id: 800, monitor: true },
  allsaints: { id: 850 }, // shorthand
  allsaints_korea: { id: 850, monitor: true },
  ameri: { id: 885 }, // shorthand
  ameri_vintage: { id: 885, monitor: true },
  and_mall: { id: 644, monitor: true },
  andar: { id: 878 }, // shorthand
  andar_japan: { id: 878, monitor: true },
  andar_korea: { id: 902 },
  andar_singapore: { id: 916 },
  another_address: { id: 811, monitor: true },
  aoure: { id: 813, monitor: true },
  asics: { id: 845, botProtected: true }, // shorthand
  asics_japan: { id: 845, monitor: true, botProtected: true },
  azul: { id: 700 }, // shorthand
  azul_by_moussy: { id: 700, monitor: true },

  // ── B ────────────────────────────────────────────────────────────────
  banana_republic: { id: 888, monitor: true },
  barbour: { id: 882, monitor: true },
  barneys: { id: 731 }, // shorthand
  barneys_japan: { id: 731, monitor: true },
  beams: { id: 792, monitor: true },
  bottega: { id: 914, botProtected: true },
  bottega_veneta: { id: 914, botProtected: true },
  bottega_veneta_japan: { id: 914, botProtected: true },
  bottega_veneta_korea: { id: 915, botProtected: true },
  brooks_brothers: { id: 730, monitor: true },
  brooks_brothers_korea: { id: 905, monitor: true },
  bshop: { id: 768, monitor: true },
  buyma: { id: 561, monitor: true },
  by_malene_birger: { id: 490, monitor: true, botProtected: true },

  // ── C ────────────────────────────────────────────────────────────────
  callaway: { id: 837 }, // shorthand
  callawaygolf: { id: 837, monitor: true },
  camilla_and_marc: { id: 814, monitor: true, luxury: true },
  celford: { id: 696, monitor: true },
  classico: { id: 895 }, // shorthand
  classico_global: { id: 895, monitor: true },
  classico_taiwan: { id: 894, monitor: true },
  coen: { id: 777, monitor: true },
  cox: { id: 687, monitor: true },

  // ── D ────────────────────────────────────────────────────────────────
  denimlife: { id: 682, monitor: true },
  dinos: { id: 64, monitor: true },

  // ── E ────────────────────────────────────────────────────────────────
  edwin: { id: 770, monitor: true },
  emmi: { id: 786, monitor: true },
  estnation: { id: 442, monitor: true, luxury: true },

  // ── F ────────────────────────────────────────────────────────────────
  fashion_square: { id: 757, monitor: true },
  felissimo: { id: 851, monitor: true, luxury: true },
  fl_sportswear: { id: 854, monitor: true },
  flandre: { id: 294, monitor: true },
  frans_boone: { id: 122, monitor: true },
  fray_i_d: { id: 693, monitor: true },
  furfur: { id: 822, monitor: true },

  // ── G ────────────────────────────────────────────────────────────────
  gap: { id: 890 }, // shorthand
  gap_japan: { id: 890, monitor: true },
  gelato: { id: 760 }, // shorthand
  gelato_pique: { id: 760, monitor: true },
  grace_continental: { id: 745, monitor: true },

  // ── H ────────────────────────────────────────────────────────────────
  hankyu: { id: 502 }, // shorthand
  hankyu_hanshin: { id: 502, monitor: true },
  hankyu_mens: { id: 543, monitor: true },

  // ── I ────────────────────────────────────────────────────────────────
  id_look: { id: 710, monitor: true },

  // ── J ────────────────────────────────────────────────────────────────
  jamie_kay: { id: 897, monitor: true },
  johnbull: { id: 714 }, // geo-restricted (CloudFront blocks non-JP)

  // ── L ────────────────────────────────────────────────────────────────
  levi: { id: 771 }, // shorthand
  levi_japan: { id: 771, monitor: true },
  lily_brown: { id: 740, monitor: true },
  llbean: { id: 801, monitor: true },
  lumine: { id: 169, monitor: true },

  // ── M ────────────────────────────────────────────────────────────────
  makes: { id: 783, monitor: true },
  marui: { id: 535, monitor: true },
  miesrohe: { id: 812, monitor: true },
  milaowen: { id: 694, monitor: true },

  // ── N ────────────────────────────────────────────────────────────────
  nagaileben: { id: 781, monitor: true },
  natulan: { id: 889, monitor: true },
  nmwa: { id: 539 }, // shorthand
  no_man_walks_alone: { id: 539 },
  nudie: { id: 133 }, // shorthand
  nudie_jeans: { id: 133 },

  // ── O ────────────────────────────────────────────────────────────────
  onward: { id: 761, monitor: true },

  // ── P ────────────────────────────────────────────────────────────────
  paul_smith: { id: 802, monitor: true },
  poppy: { id: 901, monitor: true },
  punyus: { id: 121, monitor: true },

  // ── R ────────────────────────────────────────────────────────────────
  ragtag: { id: 135, monitor: true },
  ralph_lauren: { id: 785, botProtected: true },
  ralph_lauren_australia: { id: 804, botProtected: true },
  ralph_lauren_china: { id: 830, botProtected: true },
  ralph_lauren_korea: { id: 829, botProtected: true },
  ralph_lauren_singapore: { id: 849, botProtected: true },
  ralph_lauren_taiwan: { id: 896, botProtected: true },
  ralph_lauren_uk: { id: 903, botProtected: true },
  re_edit: { id: 810, monitor: true },
  reebok: { id: 892 }, // shorthand
  reebok_korea: { id: 892, monitor: true },
  restir: { id: 610, monitor: true },
  retouch: { id: 911, monitor: true },
  rl: { id: 785, botProtected: true }, // shorthand

  // ── S ────────────────────────────────────────────────────────────────
  safari_lounge: { id: 690, monitor: true },
  sanyo: { id: 861 }, // shorthand
  sanyo_online_store: { id: 861, monitor: true },
  seilin: { id: 762 }, // shorthand
  seilin_online_shop: { id: 762, monitor: true },
  shel_tter: { id: 697, monitor: true, luxury: true },
  sixpad: { id: 886, monitor: true },
  snidel: { id: 695, monitor: true },
  snkrdunk: { id: 915 },
  stancal: { id: 713 }, // shorthand
  standard_california: { id: 713, monitor: true },
  strasburgo: { id: 452, monitor: true },
  strasburgo_outlet: { id: 799, monitor: true },
  style_deli: { id: 136, monitor: true },
  studio_nicholson: { id: 908, monitor: true },

  // ── T ────────────────────────────────────────────────────────────────
  taion: { id: 789 }, // shorthand
  taion_wear: { id: 789, monitor: true },
  top_floor: { id: 775, monitor: true },

  // ── U ────────────────────────────────────────────────────────────────
  ua: { id: 805 }, // shorthand
  ua_taiwan: { id: 473, monitor: true },
  under_armour: { id: 805, monitor: true },
  underarmour: { id: 805 }, // shorthand
  unitedarrows: { id: 907 }, // shorthand
  unitedarrows_global: { id: 907, monitor: true, luxury: true },

  // ── W ────────────────────────────────────────────────────────────────
  world: { id: 739, monitor: true },

  // ── Y ────────────────────────────────────────────────────────────────
  yohji: { id: 306 }, // shorthand
  yohji_global: { id: 876, monitor: true },
  yohji_wildside: { id: 826, monitor: true, luxury: true },
  yohji_yamamoto: { id: 306, monitor: true, luxury: true },
  yosoou: { id: 898, monitor: true },

  // ── Z ────────────────────────────────────────────────────────────────
  zuica: { id: 842, monitor: true },
};

// ── Derived lists (do not edit — update STORES above instead) ────────────────

/** All alias → store_id mappings, for slash command parsing. */
export const STORE_ALIASES = Object.fromEntries(
  Object.entries(STORES).map(([alias, s]) => [alias, s.id]),
);

/** Canonical monitor stores: alias → store_id, for the inpage monitor workflow. */
export const MONITOR_STORES = Object.fromEntries(
  Object.entries(STORES)
    .filter(([, s]) => s.monitor)
    .map(([alias, s]) => [alias, s.id]),
);

/** Stores that cannot be automated due to bot detection or unsupported structure. */
export const BOT_PROTECTED_ALIASES = new Set(
  Object.entries(STORES)
    .filter(([, s]) => s.botProtected)
    .map(([alias]) => alias),
);

export const BOT_PROTECTED_REASON =
  "Bot detection or unsupported website structure — please test manually.";
