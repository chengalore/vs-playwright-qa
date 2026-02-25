export async function verifyEvents(
  page,
  firedEvents,
  expected,
  timeout = 10000
) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const allPresent = expected.every((e) =>
      firedEvents.some((f) => f.startsWith(e))
    );

    if (allPresent) break;

    await page.waitForTimeout(250);
  }

  return expected.filter((e) => !firedEvents.some((f) => f.startsWith(e)));
}
