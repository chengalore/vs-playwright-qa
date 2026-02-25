export function startVirtusizeEventWatcher(page) {
  const firedEvents = [];

  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().match(/events\.virtusize\.(jp|com|kr)/)
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

  return firedEvents;
}
