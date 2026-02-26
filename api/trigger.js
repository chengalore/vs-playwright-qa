export default async function handler(req, res) {
  try {
    let url;

    if (req.method === "POST") {
      const contentType = req.headers["content-type"] || "";

      if (contentType.includes("application/json")) {
        url = req.body?.url;
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        url = req.body?.text;
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

    const text = await gh.text();

    if (!gh.ok) {
      console.error("GitHub dispatch failed:", gh.status, text);

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
