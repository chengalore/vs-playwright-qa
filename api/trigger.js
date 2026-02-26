export default async function handler(req, res) {
  try {
    let url;

    if (req.method === "POST") {
      const contentType = req.headers["content-type"] || "";

      if (contentType.includes("application/json")) {
        url = req.body?.url;
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        url = req.body?.text; // Slack sends the URL here
      }
    } else {
      url = req.query?.url;
    }

    if (!url) {
      return res.status(200).json({
        response_type: "ephemeral",
        text: "No URL provided.",
      });
    }

    // Fire and forget (do NOT await)
    fetch(
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
    ).catch(console.error);

    // Immediate Slack response
    return res.status(200).json({
      response_type: "ephemeral",
      text: `🚀 QA started for:\n${url}`,
    });
  } catch (err) {
    return res.status(200).json({
      response_type: "ephemeral",
      text: `Error: ${err.message}`,
    });
  }
}
