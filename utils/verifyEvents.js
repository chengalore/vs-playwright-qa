function matchesExpected(event, expected) {
  if (expected.endsWith("*")) {
    const prefix = expected.slice(0, -1);
    return event.startsWith(prefix);
  }
  // Exact name match — ignore ::source suffix
  const eventName = event.split("::")[0];
  return eventName === expected || event === expected;
}

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
      events.some((f) => matchesExpected(f, e))
    );

    if (allPresent) break;

    await page.waitForTimeout(100);
  }

  const events = getEvents();
  return expected.filter((e) => !events.some((f) => matchesExpected(f, e)));
}
