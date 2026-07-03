/**
 * Vercel serverless function — listens for Slack Events API messages
 * from #analytics-alerts and auto-triggers a Single URL Test for
 * any affected store that has a fallback product URL.
 *
 * Setup: configure this URL as the Event Subscriptions Request URL
 * in the Slack app settings, subscribe to message.channels.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export const config = { api: { bodyParser: false } };

const __dirname = dirname(fileURLToPath(import.meta.url));
const fallbackProducts = JSON.parse(
  readFileSync(join(__dirname, "../data/fallbackProducts.json"), "utf8")
);

const GITHUB_REPO = process.env.GITHUB_REPO;
const GH_PAT = process.env.GH_PAT || process.env.GITHUB_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
const lastTriggered = new Map(); // storeName → timestamp

function isOnCooldown(storeName) {
  const last = lastTriggered.get(storeName);
  return last && Date.now() - last < COOLDOWN_MS;
}

async function verifySlackSignature(req, rawBody) {
  if (!SLACK_SIGNING_SECRET) return true;
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(baseString)
    .digest("hex");
  const computed = Buffer.from(`v0=${hmac}`);
  try {
    return timingSafeEqual(computed, Buffer.from(signature));
  } catch {
    return false;
  }
}

async function dispatchWorkflow(inputs) {
  const [owner, repo] = GITHUB_REPO.split("/");
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/single-url-test.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GH_PAT}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }
}

// Parses all "Store Name: seilin_online_shop <762>" occurrences from alert text
function parseStoreNames(text) {
  return [...text.matchAll(/Store Name:\s*(\S+)\s*<\d+>/g)].map((m) => m[1]);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  const rawBody = await new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
  });

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).end("Bad Request");
  }

  // One-time URL verification when configuring Event Subscriptions in Slack
  if (payload.type === "url_verification") {
    return res.status(200).json({ challenge: payload.challenge });
  }

  const valid = await verifySlackSignature(req, rawBody);
  if (!valid) return res.status(401).end("Unauthorized");

  const event = payload.event;
  if (!event || event.type !== "message") return res.status(200).end("ok");

  const text = event.text || "";

  // Only process messages that look like analytics alerts
  if (!text.includes("Analytics Alert")) return res.status(200).end("ok");

  const storeNames = parseStoreNames(text);
  if (storeNames.length === 0) return res.status(200).end("ok");

  // Dispatch a Single URL Test for each affected store that has a known URL
  for (const storeName of storeNames) {
    if (isOnCooldown(storeName)) {
      console.log(`analytics-alert: skipping ${storeName} — on cooldown`);
      continue;
    }
    const url = fallbackProducts[storeName];
    if (!url) {
      console.warn(`analytics-alert: no fallback URL for store "${storeName}"`);
      continue;
    }
    try {
      await dispatchWorkflow({ url, phase: "full", slack_response_url: "", notify_slack: "false" });
      lastTriggered.set(storeName, Date.now());
      console.log(`analytics-alert: triggered test for ${storeName} → ${url}`);
    } catch (err) {
      console.error(`analytics-alert: dispatch failed for ${storeName}: ${err.message}`);
    }
  }

  res.status(200).end("ok");
}
