export function startVirtusizeEventWatcher(page) {
  let firedEvents = [];

  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().match(/events\.(?:[\w-]+\.)?virtusize\.(jp|com|kr)/)
    ) {
      try {
        const body = request.postDataJSON();

        if (body?.name && !firedEvents.includes(body.name)) {
          firedEvents.push(body.name);
          console.log("Captured Event:", body.name);
        }
      } catch {}
    }
  });

  return {
    getEvents: () => firedEvents,
    reset: () => {
      firedEvents = [];
    },
  };
}
