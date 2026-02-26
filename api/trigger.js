export default async function handler(req, res) {
  try {
    const url = req.method === "POST" ? req.body?.url : req.query?.url;

    if (!url) {
      return res.status(400).json({ error: "No URL provided." });
    }

    const response = await fetch(
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

    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({ error: text });
    }

    return res.status(200).json({
      success: true,
      message: "Workflow triggered",
      url,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
