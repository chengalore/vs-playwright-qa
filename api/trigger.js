import { parseSlashCommand } from "./parseSlashCommand.js";
import { BOT_PROTECTED_ALIASES, BOT_PROTECTED_REASON } from "../config/botProtectedStores.js";

export default async function handler(req, res) {
  try {
    let text;

    if (req.method === "POST") {
      const contentType = req.headers["content-type"] || "";

      if (contentType.includes("application/json")) {
        text = req.body?.url ?? req.body?.text;
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        text = req.body?.text;
      }
    } else {
      text = req.query?.url ?? req.query?.text;
    }

    if (!text) {
      return res.status(200).json({
        response_type: "ephemeral",
        text: "Usage: /qa <url> OR /qa [store] [product_type] [gender]\nExamples: /qa ua shoes  |  /qa snidel  |  /qa ralph_lauren coat\nTo cancel: /qa stop",
      });
    }

    const ghHeaders = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
    };

    // ── Stop / Cancel ────────────────────────────────────────────────
    if (text.trim().toLowerCase() === "stop" || text.trim().toLowerCase() === "cancel") {
      // A workflow run moves through: queued → in_progress → completed.
      // Must check both statuses or the run is missed while it waits for a runner.
      const [inProgressRes, queuedRes] = await Promise.all([
        fetch(
          `https://api.github.com/repos/${process.env.GITHUB_REPO}/actions/workflows/inpage-qa.yml/runs?status=in_progress`,
          { headers: ghHeaders }
        ),
        fetch(
          `https://api.github.com/repos/${process.env.GITHUB_REPO}/actions/workflows/inpage-qa.yml/runs?status=queued`,
          { headers: ghHeaders }
        ),
      ]);
      const [inProgressData, queuedData] = await Promise.all([
        inProgressRes.json(),
        queuedRes.json(),
      ]);
      const runs = [
        ...(inProgressData.workflow_runs || []),
        ...(queuedData.workflow_runs || []),
      ];

      if (runs.length === 0) {
        return res.status(200).json({
          response_type: "ephemeral",
          text: "No QA tests are currently running.",
        });
      }

      await Promise.all(
        runs.map((run) =>
          fetch(
            `https://api.github.com/repos/${process.env.GITHUB_REPO}/actions/runs/${run.id}/cancel`,
            { method: "POST", headers: ghHeaders }
          )
        )
      );

      return res.status(200).json({
        response_type: "ephemeral",
        text: `✅ Cancelled ${runs.length} running test${runs.length > 1 ? "s" : ""}.`,
      });
    }

    // ── Parse command ────────────────────────────────────────────────
    const parsed = parseSlashCommand(text);

    // ── All-store monitor ─────────────────────────────────────────────
    if (parsed.scope === "all") {
      const monitorInputs = {
        phase: parsed.phase || "widget",
        store_id: parsed.store_id ? String(parsed.store_id) : "",
        product_type_id: parsed.product_type_id ? String(parsed.product_type_id) : "",
        gender: parsed.gender || "",
      };

      const gh = await fetch(
        `https://api.github.com/repos/${process.env.GITHUB_REPO}/actions/workflows/inpage-monitor.yml/dispatches`,
        {
          method: "POST",
          headers: ghHeaders,
          body: JSON.stringify({ ref: "main", inputs: monitorInputs }),
        }
      );

      if (!gh.ok) {
        const ghBody = await gh.text().catch(() => "");
        console.error("GitHub dispatch failed:", gh.status, ghBody);
        return res.status(200).json({
          response_type: "ephemeral",
          text: `GitHub dispatch failed (${gh.status})`,
        });
      }

      return res.status(200).json({
        response_type: "ephemeral",
        text: `⏳ Monitoring all stores (phase: ${monitorInputs.phase})...`,
      });
    }

    // ── Bot-protected stores ──────────────────────────────────────────
    if (parsed.store_alias && BOT_PROTECTED_ALIASES.has(parsed.store_alias)) {
      return res.status(200).json({
        response_type: "ephemeral",
        text: `⛔ *${parsed.store_alias}* cannot be automated — ${BOT_PROTECTED_REASON}`,
      });
    }

    let inputs;
    if (parsed.url) {
      // Direct URL — pass straight through
      inputs = {
        url: parsed.url,
        store_id: "",
        store_alias: "",
        product_type_id: "",
        gender: "",
        exclude_kids: "",
        phase: parsed.phase || "full",
      };
    } else {
      if (!parsed.store_id) {
        return res.status(200).json({
          response_type: "ephemeral",
          text: "Please specify a store name.\nExamples: /qa ua shoes  |  /qa snidel skirt  |  /qa ralph_lauren",
        });
      }
      inputs = {
        url: "",
        store_id: String(parsed.store_id),
        store_alias: parsed.store_alias || "",
        product_type_id: parsed.product_type_id ? String(parsed.product_type_id) : "",
        gender: parsed.gender || "",
        exclude_kids: parsed.exclude_kids ? "true" : "",
        phase: parsed.phase || "full",
      };
    }

    // ── Dispatch to GitHub Actions (single fast API call) ────────────
    const gh = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPO}/actions/workflows/inpage-qa.yml/dispatches`,
      {
        method: "POST",
        headers: ghHeaders,
        body: JSON.stringify({ ref: "main", inputs }),
      }
    );

    if (!gh.ok) {
      const ghBody = await gh.text().catch(() => "");
      console.error("GitHub dispatch failed:", gh.status, ghBody);
      return res.status(200).json({
        response_type: "ephemeral",
        text: `GitHub dispatch failed (${gh.status})`,
      });
    }

    return res.status(200).json({
      response_type: "ephemeral",
      text: parsed.url
        ? `⏳ QA started for:\n${parsed.url}`
        : "⏳ QA queued! Finding a valid product...",
    });

  } catch (err) {
    console.error("Server error:", err);
    return res.status(200).json({
      response_type: "ephemeral",
      text: `Server error: ${err.message}`,
    });
  }
}
