export function startVirtusizeEventWatcher(page) {
  let currentPhase = "onboarding";
  let events = [];
  let counts = {};

  // Per-phase storage
  const phases = {};

  const ensurePhase = (phase) => {
    if (!phases[phase]) phases[phase] = { events: [], counts: {} };
  };

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

        // Global (for backwards-compat — reset() still clears these)
        events.push({ name, source });
        counts[key] = (counts[key] || 0) + 1;

        // Per-phase
        ensurePhase(currentPhase);
        phases[currentPhase].events.push({ name, source });
        phases[currentPhase].counts[key] =
          (phases[currentPhase].counts[key] || 0) + 1;

        console.log(
          `[PHASE ${currentPhase}] ${name} (source: ${source}) x${phases[currentPhase].counts[key]}`
        );
      } catch {}
    }
  });

  return {
    // Global accessors (backwards-compat)
    getEvents: () => events.map((e) => `${e.name}::${e.source}`),
    getCounts: () => counts,

    // Phase control
    setPhase(name) {
      currentPhase = name;
      ensurePhase(name);
      console.log(`[EVENT WATCHER] Phase → ${name}`);
    },

    // Per-phase accessors
    getPhaseEvents: (phase) =>
      (phases[phase]?.events ?? []).map((e) => `${e.name}::${e.source}`),
    getPhaseCounts: (phase) => phases[phase]?.counts ?? {},

    // Log a summary of all phases (useful at end of test)
    logPhaseSummary() {
      for (const [phase, data] of Object.entries(phases)) {
        const lines = Object.entries(data.counts)
          .map(([key, n]) => `  ${key} x${n}`)
          .join("\n");
        console.log(`[PHASE ${phase}]\n${lines || "  (no events)"}`);
      }
    },

    // reset() clears global state but preserves phase history
    reset() {
      events = [];
      counts = {};
    },
  };
}
