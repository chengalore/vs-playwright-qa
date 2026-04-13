/**
 * Dashboard server — serves static files and provides a /run/:spec endpoint
 * to trigger Playwright tests from the dashboard UI.
 *
 * Usage: npm run dashboard
 */

import http from "http";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { createHmac, timingSafeEqual } from "crypto";
import { config } from "dotenv";
config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3030;

const MIME = {
  ".html": "text/html",
  ".json": "application/json",
  ".png": "image/png",
  ".js": "text/javascript",
  ".css": "text/css",
};

const SPEC_COMMANDS = {
  monitor: ["npx", ["playwright", "test", "tests/monitor.spec.js", "--project=chrome", "--reporter=list"]],
  inpage:  ["npx", ["playwright", "test", "tests/inpage.spec.js",  "--project=chrome", "--reporter=list"]],
  overlay: ["npx", ["playwright", "test", "tests/overlay-qa.spec.js", "--project=chrome", "--reporter=list"]],
  cart:    ["npx", ["playwright", "test", "tests/addToCart.spec.js", "--project=chrome", "--reporter=list"]],
};

// GitHub repo for workflow dispatch (owner/repo)
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GH_PAT = process.env.GH_PAT || "";
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";

async function verifySlackSignature(req, rawBody) {
  if (!SLACK_SIGNING_SECRET) return true; // skip verification if secret not configured
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false; // replay protection
  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", SLACK_SIGNING_SECRET).update(baseString).digest("hex");
  const computed = Buffer.from(`v0=${hmac}`);
  try { return timingSafeEqual(computed, Buffer.from(signature)); } catch { return false; }
}

const MONITOR_PATTERN = /^(monitor|all)\b(.*)$/i;

function parseMonitorRequest(instruction) {
  const match = instruction.trim().match(MONITOR_PATTERN);
  if (!match) return null;
  const rest = match[2].trim().toLowerCase();
  const phase = rest.includes("api") ? "api" : "widget";
  return { phase };
}

async function dispatchWorkflow(workflow, inputs) {
  if (!GITHUB_REPO || !GH_PAT) throw new Error("GITHUB_REPO and GH_PAT must be set in .env");
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

async function triggerMonitorWorkflow(phase = "widget") {
  await dispatchWorkflow("inpage-monitor.yml", {
    phase,
    store_id: "",
    product_type_id: "",
    gender: "",
    browser: "chrome",
  });
}

// Track running processes
const running = {};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── POST /slack/command — receive /qa slash command ──────────────────────
  if (req.method === "POST" && url.pathname === "/slack/command") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      const valid = await verifySlackSignature(req, body);
      if (!valid) { res.writeHead(401); res.end("Unauthorized"); return; }

      const params = new URLSearchParams(body);
      const instruction = params.get("text")?.trim();
      const responseUrl = params.get("response_url");

      if (!instruction) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: "Usage: /qa <instruction>\nExample: /qa check if widget shows on poppy" }));
        return;
      }

      // Route: monitor vs agent
      const monitorOpts = parseMonitorRequest(instruction);

      if (!monitorOpts) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: "❌ Unrecognized command. Supported:\n• `/qa monitor` — run all stores\n• `/qa <URL>` — test a specific product URL" }));
        return;
      }

      // Acknowledge immediately (Slack requires response within 3 seconds)
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        text: `⏳ Starting monitor for all stores (phase: ${monitorOpts.phase})... Results will be posted when done.`,
      }));

      // Trigger workflow asynchronously
      const trigger = triggerMonitorWorkflow(monitorOpts.phase);

      trigger.catch(async err => {
        console.error("[slack] workflow trigger failed:", err.message);
        if (responseUrl) {
          await fetch(responseUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: `❌ Failed to start: ${err.message}` }),
          }).catch(() => {});
        }
      });
    });
    return;
  }

  // ── POST /run/:spec — start a test ────────────────────────────────────────
  if (req.method === "POST" && url.pathname.startsWith("/run/")) {
    const spec = url.pathname.split("/")[2];
    if (!SPEC_COMMANDS[spec]) {
      res.writeHead(400); res.end("Unknown spec"); return;
    }
    if (running[spec]) {
      res.writeHead(409); res.end("Already running"); return;
    }

    const [cmd, args] = SPEC_COMMANDS[spec];
    const proc = spawn(cmd, args, { cwd: __dirname, shell: true });
    running[spec] = { pid: proc.pid, startTime: Date.now(), output: [] };

    proc.stdout.on("data", d => running[spec].output.push(d.toString()));
    proc.stderr.on("data", d => running[spec].output.push(d.toString()));
    proc.on("close", code => {
      running[spec].exitCode = code;
      running[spec].done = true;
      running[spec].durationMs = Date.now() - running[spec].startTime;
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ started: true, spec }));
    return;
  }

  // ── GET /status/:spec — poll test status ──────────────────────────────────
  if (req.method === "GET" && url.pathname.startsWith("/status/")) {
    const spec = url.pathname.split("/")[2];
    const state = running[spec];
    if (!state) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running: false }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      running: !state.done,
      done: !!state.done,
      exitCode: state.exitCode ?? null,
      durationMs: state.done ? state.durationMs : Date.now() - state.startTime,
      output: state.output.slice(-50).join(""),
    }));
    return;
  }

  // ── Static file server ────────────────────────────────────────────────────
  let filePath = path.join(__dirname, url.pathname === "/" ? "dashboard.html" : url.pathname);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404); res.end("Not found"); return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`\n✅ Dashboard ready → http://localhost:${PORT}/dashboard.html\n`);
});
