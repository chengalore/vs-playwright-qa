export function startVirtusizeEventWatcher(page) {
  let events = [];
  let counts = {};

  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().match(/events\.(?:[\w-]+\.)?virtusize\.(jp|com|kr)/)
    ) {
      try {
        const body = request.postDataJSON();
        const name = body?.name;
        const source = body?.source || "unknown";

        if (!name) return;

        const key = `${name}::${source}`;

        // store all events (no deduping)
        events.push({ name, source });

        // count occurrences
        counts[key] = (counts[key] || 0) + 1;

        console.log(
          `Captured Event: ${name} (source: ${source}) x${counts[key]}`
        );
      } catch {}
    }
  });

  return {
    getEvents: () => events.map((e) => `${e.name}::${e.source}`),
    getCounts: () => counts,
    reset: () => {
      events = [];
      counts = {};
    },
  };
}
