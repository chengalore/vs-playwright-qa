import { resolveSlashCommandUrl } from "./parseSlashCommand.js";

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
        text: "Usage: /qa <url> OR /qa [store] [product_type] [gender]\nExamples: /qa ua shoes  |  /qa kids  |  /qa ralph_lauren coat\nTo cancel: /qa stop",
      });
    }

    // Cancel any in-progress runs
    if (text.trim().toLowerCase() === "stop" || text.trim().toLowerCase() === "cancel") {
      const runsRes = await fetch(
        `https://api.github.com/repos/${process.env.GITHUB_REPO}/actions/workflows/inpage-qa.yml/runs?status=in_progress`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          },
        }
      );
      const runsData = await runsRes.json();
      const runs = runsData.workflow_runs || [];

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
            {
              method: "POST",
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
              },
            }
          )
        )
      );

      return res.status(200).json({
        response_type: "ephemeral",
        text: `Cancelled ${runs.length} running test${runs.length > 1 ? "s" : ""}.`,
      });
    }

    let url;
    try {
      url = await resolveSlashCommandUrl(text);
    } catch (err) {
      return res.status(200).json({
        response_type: "ephemeral",
        text: `Could not resolve URL: ${err.message}`,
      });
    }

    if (!url) {
      return res.status(200).json({
        response_type: "ephemeral",
        text: "Could not resolve a URL. Please provide a store name or direct URL.\nExample: /qa ua shoes",
      });
    }

    const gh = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPO}/actions/workflows/inpage-qa.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: { url },
        }),
      }
    );

    const ghBody = await gh.text();

    if (!gh.ok) {
      console.error("GitHub dispatch failed:", gh.status, ghBody);

      return res.status(200).json({
        response_type: "ephemeral",
        text: `GitHub dispatch failed (${gh.status})`,
      });
    }

    return res.status(200).json({
      response_type: "ephemeral",
      text: `QA started for:\n${url}`,
    });
  } catch (err) {
    console.error("Server error:", err);

    return res.status(200).json({
      response_type: "ephemeral",
      text: `Server error: ${err.message}`,
    });
  }
}
