import { resolveSlashCommandUrl } from "./parseSlashCommand.js";

async function replyToSlack(responseUrl, text) {
  if (!responseUrl) return;
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
  }).catch((err) => console.error("Failed to reply to Slack:", err));
}

export default async function handler(req, res) {
  try {
    let text;
    let responseUrl;

    if (req.method === "POST") {
      const contentType = req.headers["content-type"] || "";

      if (contentType.includes("application/json")) {
        text = req.body?.url ?? req.body?.text;
        responseUrl = req.body?.response_url;
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        text = req.body?.text;
        responseUrl = req.body?.response_url;
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
      // Respond immediately, then cancel async
      res.status(200).json({ response_type: "ephemeral", text: "⏳ Cancelling..." });

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
        return replyToSlack(responseUrl, "No QA tests are currently running.");
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

      return replyToSlack(responseUrl, `Cancelled ${runs.length} running test${runs.length > 1 ? "s" : ""}.`);
    }

    // Respond to Slack immediately to avoid 3s timeout
    res.status(200).json({ response_type: "ephemeral", text: "⏳ Finding a valid product..." });

    // Do the rest async
    (async () => {
      try {
        const url = await resolveSlashCommandUrl(text);

        if (!url) {
          return replyToSlack(responseUrl, "Could not resolve a URL. Please provide a store name or direct URL.\nExample: /qa ua shoes");
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
            body: JSON.stringify({ ref: "main", inputs: { url } }),
          }
        );

        if (!gh.ok) {
          const ghBody = await gh.text().catch(() => "");
          console.error("GitHub dispatch failed:", gh.status, ghBody);
          return replyToSlack(responseUrl, `GitHub dispatch failed (${gh.status})`);
        }

        return replyToSlack(responseUrl, `✅ QA started for:\n${url}`);
      } catch (err) {
        console.error("Async error:", err);
        return replyToSlack(responseUrl, `Error: ${err.message}`);
      }
    })();

  } catch (err) {
    console.error("Server error:", err);

    return res.status(200).json({
      response_type: "ephemeral",
      text: `Server error: ${err.message}`,
    });
  }
}
