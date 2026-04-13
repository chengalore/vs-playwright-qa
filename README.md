# VS Playwright QA

Automated end-to-end QA platform for Virtusize widgets. Runs real user interaction flows on partner store product pages, verifies widget rendering and event sequences, and publishes results to a GitHub Pages dashboard and Slack.

No backend required — runs entirely on GitHub Actions, GitHub Pages, and a Vercel serverless function for the Slack integration.

---

## Architecture

```
Slack /qa command
      │
      ▼
api/slack.js (Vercel)
      │
      ├── /qa monitor       → inpage-monitor.yml   (all stores, 5 parallel runners)
      └── /qa <URL>         → single-url-test.yml  (one URL, 3 browsers in parallel)
                                        │
                                        ▼
                              GitHub Pages dashboard
                       https://chengalore.github.io/vs-playwright-qa/
```

---

## Tests

| Spec | Purpose |
|---|---|
| `tests/inpage.spec.js` | Full user journey through the inpage widget — PDC check, widget open, onboarding, recommendations, size selection, wardrobe, gift flow, refresh |
| `tests/monitor.spec.js` | Sweeps all monitored stores in parallel to verify widget health |
| `tests/compare-view-screenshot.spec.js` | Opens the bag widget, runs the bag flow, and screenshots for manual visual review |
| `tests/addToCart.spec.js` | Validates the add-to-cart flow after size recommendation |

---

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `inpage-monitor.yml` | Schedule / `/qa monitor` | Resolves URLs for all monitored stores, splits into 5 chunks, runs in parallel, posts summary to Slack, publishes to dashboard |
| `single-url-test.yml` | `/qa <URL>` / GitHub UI | Runs inpage test across chrome, firefox, webkit in parallel, posts result to Slack, publishes to dashboard |

---

## Dashboard

Live at: **https://chengalore.github.io/vs-playwright-qa/**

Built automatically by `scripts/build-dashboard.js` after every monitor or single-URL run. Panels:

- **Monitor** — full run history (up to 50 runs), expandable per-run detail showing failed/missing stores with URLs and browser info
- **Single URL** — history of per-URL tests with per-browser pass/fail
- **Compare View** — screenshot gallery from `compare-view-screenshot.spec.js`
- **Inpage / Add to Cart** — run instructions

---

## Slack Commands

| Command | Action |
|---|---|
| `/qa monitor` | Run all monitored stores (widget phase) |
| `/qa monitor api` | Run all monitored stores (api phase) |
| `/qa <URL>` | Test a specific product page URL across 3 browsers |

---

## Running Locally

```bash
# Install dependencies
npm install
npx playwright install

# Run inpage test (single URL)
TEST_URL="https://..." npx playwright test tests/inpage.spec.js --project=chrome

# Run monitor (uses fallback URLs)
npx playwright test tests/monitor.spec.js --project=chrome

# Run compare view screenshots
npx playwright test tests/compare-view-screenshot.spec.js --project=chrome --reporter=list

# Run add to cart
npx playwright test tests/addToCart.spec.js --project=chrome
```

Test phases (`TEST_PHASE` env var): `api` | `widget` | `events` | `onboarding` | `full` (default)

---

## Project Structure

```
tests/                        # Playwright test specs
utils/                        # Shared helpers (watchers, flow runners, etc.)
config/
  stores.js                   # All store aliases and IDs
  expectedEvents.js           # Expected Virtusize event sequences
  monitorStores.js            # Stores included in the monitor sweep
data/
  fallbackProducts.json       # Fallback URLs per store (committed)
  monitor-history.json        # Monitor run history (committed)
  single-url-history.json     # Single URL test history (committed)
  compare-view-screenshot-urls.txt  # URLs for compare view screenshots
scripts/
  build-dashboard.js          # Generates docs/index.html
  split-monitor-chunks.js     # Splits stores into 5 parallel chunks
api/
  slack.js                    # Vercel serverless function for /qa Slack command
docs/
  index.html                  # GitHub Pages dashboard (auto-generated)
.github/workflows/
  inpage-monitor.yml          # Multi-store monitor workflow
  single-url-test.yml         # Single URL / inpage QA workflow
```

---

## Setup (New Repo)

1. Clone or transfer this repo to your GitHub org
2. Add the following repository secrets (`Settings → Secrets → Actions`):

| Secret | Purpose |
|---|---|
| `RANDOM_PRODUCT_API_URL` | Virtusize API for resolving random product URLs per store |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook for monitor summaries |
| `DASHBOARD_URL` | GitHub Pages URL (e.g. `https://your-org.github.io/vs-playwright-qa/`) |
| `ANTHROPIC_API_KEY` | Reserved — not currently used |

3. Enable GitHub Pages: `Settings → Pages → Deploy from branch → main /docs`
4. Deploy `api/slack.js` to Vercel and point your Slack slash command URL at it
5. Update `DASHBOARD_URL` secret to match the GitHub Pages URL
