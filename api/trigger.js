export default async function handler(req, res) {
  const { text } = req.body;

  if (!text) {
    return res.status(400).send("No URL provided.");
  }

  await fetch(
    "https://api.github.com/repos/chengalore/vs-playwright-qa/actions/workflows/inpage-qa.yml/dispatches",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          url: text,
        },
      }),
    }
  );

  return res
    .status(200)
    .send(`QA started for: ${text}\nResults will be posted shortly.`);
}
