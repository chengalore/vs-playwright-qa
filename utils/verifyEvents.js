export async function verifyEvents(
  page,
  firedEvents,
  expected,
  timeout = 10000
) {
  const getEvents = typeof firedEvents === "function" ? firedEvents : () => firedEvents;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const events = getEvents();
    const allPresent = expected.every((e) =>
      events.some((f) => f.startsWith(e))
    );

    if (allPresent) break;

    await page.waitForTimeout(100);
  }

  const events = getEvents();
  return expected.filter((e) => !events.some((f) => f.startsWith(e)));
}
