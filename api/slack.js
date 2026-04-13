/**
 * Vercel serverless function — handles /qa Slack slash command.
 *
 * Routes:
 *   /qa all [widget|api]  → triggers inpage-monitor.yml
 *   /qa monitor           → triggers inpage-monitor.yml
 *   /qa <instruction>     → triggers agent-qa.yml
 */

import { createHmac, timingSafeEqual } from "crypto";

export const config = {
  api: { bodyParser: false },
};

const GITHUB_REPO = process.env.GITHUB_REPO;
const GH_PAT = process.env.GH_PAT || process.env.GITHUB_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

const MONITOR_PATTERN = /^(monitor|all)\b(.*)$/i;
const URL_ONLY_PATTERN = /^https?:\/\/\S+$/i;

function parseMonitorRequest(instruction) {
  const match = instruction.trim().match(MONITOR_PATTERN);
  if (!match) return null;
  const rest = match[2].trim().toLowerCase();
  const phase = rest.includes("api") ? "api" : "widget";
  return { phase };
}

async function verifySlackSignature(req, rawBody) {
  if (!SLACK_SIGNING_SECRET) return true;
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", SLACK_SIGNING_SECRET).update(baseString).digest("hex");
  const computed = Buffer.from(`v0=${hmac}`);
  try { return timingSafeEqual(computed, Buffer.from(signature)); } catch { return false; }
}

async function dispatchWorkflow(workflow, inputs) {
  const [owner, repo] = GITHUB_REPO.split("/");
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`,
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).end("Method Not Allowed");
    return;
  }

  // Parse raw body for signature verification
  const rawBody = await new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
  });

  const valid = await verifySlackSignature(req, rawBody);
  if (!valid) {
    res.status(401).end("Unauthorized");
    return;
  }

  const params = new URLSearchParams(rawBody);
  const instruction = params.get("text")?.trim();
  const responseUrl = params.get("response_url");

  if (!instruction) {
    res.status(200).json({
      response_type: "ephemeral",
      text: "Usage: /qa <instruction>\nExamples:\n• /qa check widget on snidel\n• /qa all widget\n• /qa monitor",
    });
    return;
  }

  const monitorOpts = parseMonitorRequest(instruction);

  // If instruction is just a URL, run the full inpage test flow
  const resolvedInstruction = URL_ONLY_PATTERN.test(instruction)
    ? `Run the full inpage test on ${instruction}. Call navigate_to_store with that URL, then call run_inpage_test to automatically detect the flow (apparel/kids/bag/footwear) and run the complete widget + onboarding + refresh validation. Report the result including the detected flow type and store.`
    : instruction;

  // Trigger GitHub workflow first, then respond to Slack
  try {
    if (monitorOpts) {
      await dispatchWorkflow("inpage-monitor.yml", {
        phase: monitorOpts.phase,
        store_id: "",
        product_type_id: "",
        gender: "",
        browser: "chrome",
      });
    } else {
      await dispatchWorkflow("agent-qa.yml", {
        instruction: resolvedInstruction,
        slack_response_url: responseUrl || "",
      });
    }
  } catch (err) {
    console.error("Workflow dispatch failed:", err.message);
    res.status(200).json({
      response_type: "ephemeral",
      text: `❌ Failed to start: ${err.message}`,
    });
    return;
  }

  res.status(200).json({
    response_type: "ephemeral",
    text: monitorOpts
      ? `⏳ Starting monitor for all stores (phase: ${monitorOpts.phase})...`
      : `Starting agent test: _"${resolvedInstruction}"_\nI'll report back when done.`,
  });
}
