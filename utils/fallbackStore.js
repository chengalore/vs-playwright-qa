/**
 * Persistent fallback URL store for the Random Product API.
 *
 * Saves the last known-good PDP URL per store alias so that when the
 * Random Product API fails or returns invalid products, the previous
 * successful URL can be used as a fallback.
 *
 * File: data/fallbackProducts.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FALLBACK_FILE = join(__dirname, "../data/fallbackProducts.json");

function readFallbacks() {
  if (!existsSync(FALLBACK_FILE)) return {};
  try {
    return JSON.parse(readFileSync(FALLBACK_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Returns the last successful PDP URL for a store alias, or null if none saved. */
export function loadFallback(storeAlias) {
  return readFallbacks()[storeAlias] ?? null;
}

/** Saves a PDP URL as the last successful product for a store alias. */
export function saveFallback(storeAlias, url) {
  if (!storeAlias || !url) return;
  const data = readFallbacks();
  data[storeAlias] = url;
  mkdirSync(join(__dirname, "../data"), { recursive: true });
  writeFileSync(FALLBACK_FILE, JSON.stringify(data, null, 2));
}
