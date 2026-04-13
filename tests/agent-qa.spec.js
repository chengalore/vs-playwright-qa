/**
 * AI-driven Virtusize QA agent.
 *
 * Give Claude a natural language instruction and it will plan and run the test
 * using the existing Virtusize test utilities.
 *
 * Usage:
 *   INSTRUCTION="test onboarding for snidel" ANTHROPIC_API_KEY=sk-... \
 *   npx playwright test tests/agent-qa.spec.js --project=chrome
 *
 * Examples:
 *   INSTRUCTION="check if the widget shows on poppy"
 *   INSTRUCTION="run the full apparel flow on yosoou"
 *   INSTRUCTION="test gift onboarding for hankyu_mens"
 *   INSTRUCTION="verify the widget loads on https://snidel.com/..."
 */

import { test, expect } from "@playwright/test";
import Anthropic from "@anthropic-ai/sdk";
import { startVirtusizeEventWatcher } from "../utils/eventWatcher.js";
import { startPDCWatcher } from "../utils/pdcWatcher.js";
import { startRecommendationWatcher } from "../utils/recommendationWatcher.js";
import { startBodyMeasurementWatcher } from "../utils/bodyMeasurementWatcher.js";
import { completeOnboarding } from "../utils/completeOnboarding.js";
import { blockMarketingScripts } from "../utils/blockMarketingScripts.js";
import { loadFallback } from "../utils/fallbackStore.js";
import { BOT_PROTECTED_DOMAINS } from "../config/stores.js";
import { runInpageFlow } from "../utils/inpageFlow.js";

test.setTimeout(360000); // 6 min — full inpage flow can take ~200s + API overhead

const INSTRUCTION = process.env.INSTRUCTION;
if (!INSTRUCTION) throw new Error("INSTRUCTION env var is required.\n\nExample: INSTRUCTION=\"test onboarding for snidel\"");

const client = new Anthropic();

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "navigate_to_store",
    description:
      "Navigate to a store product page. Provide either a store_alias (e.g. 'snidel') " +
      "to use the known fallback URL, or a direct url. Returns the URL navigated to.",
    input_schema: {
      type: "object",
      properties: {
        store_alias: { type: "string", description: "Store alias, e.g. 'snidel', 'gelato_pique', 'hankyu_mens'" },
        url: { type: "string", description: "Direct PDP URL to navigate to (overrides store_alias)" },
      },
    },
  },
  {
    name: "get_page_info",
    description:
      "Get the current page state: PDC info (store name, product type, valid product flag), " +
      "and whether the Virtusize widget container is present in the DOM.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "open_widget",
    description: "Click the Virtusize widget button to open the aoyama panel.",
    input_schema: {
      type: "object",
      properties: {
        flow: {
          type: "string",
          enum: ["apparel", "luxury", "bag"],
          description: "Widget flow type. Use 'apparel' if unsure.",
        },
      },
    },
  },
  {
    name: "complete_onboarding",
    description:
      "Fill in and submit the Virtusize onboarding form (age, height, weight, privacy policy). " +
      "The widget must already be open. Returns whether onboarding was completed.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "check_events",
    description: "Return the Virtusize analytics events that have fired on the page so far.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "wait",
    description: "Wait for a number of milliseconds. Use when the UI needs time to settle.",
    input_schema: {
      type: "object",
      properties: {
        ms: { type: "number", description: "Milliseconds to wait (max 5000)" },
      },
      required: ["ms"],
    },
  },
  {
    name: "take_screenshot",
    description: "Take a screenshot of the current page state and attach it to the test report.",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Short label for the screenshot" },
      },
      required: ["label"],
    },
  },
  {
    name: "run_inpage_test",
    description:
      "Run the complete inpage.spec.js test flow on the already-navigated page. " +
      "Automatically detects the product type (apparel, kids, bag, footwear, noVisor), " +
      "opens the widget, completes onboarding, validates analytics events, and runs a " +
      "refresh validation. Always call navigate_to_store first. Use this whenever the " +
      "instruction is to test a URL or verify the widget works end-to-end.",
    input_schema: {
      type: "object",
      properties: {
        phase: {
          type: "string",
          enum: ["widget", "onboarding", "full"],
          description:
            "'widget': open the widget only. " +
            "'onboarding': open + complete the onboarding form. " +
            "'full': complete flow including event validation and page refresh (default).",
        },
      },
    },
  },
  {
    name: "report_result",
    description: "Report the final test result. Call this when you are done.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["passed", "failed", "skipped"] },
        summary: { type: "string", description: "What was tested and the outcome in 1-2 sentences." },
        error: { type: "string", description: "Error or failure details if status is failed." },
      },
      required: ["status", "summary"],
    },
  },
];

const SYSTEM_PROMPT = `You are a QA automation agent for Virtusize, a size recommendation widget embedded in e-commerce stores.

You control a real browser (Playwright) through tool calls. Your job is to carry out the user's test instruction step by step.

## What you know about Virtusize
- Every store has a widget button on the product page. Clicking it opens the aoyama panel.
- New users see an onboarding form (age, height, weight) before getting a size recommendation.
- Some stores have a "gift flow" — a separate CTA for gifting that also collects onboarding data.
- The widget fires analytics events (e.g. user-saw-widget-button, user-opened-widget, user-completed-onboarding).

## How to run a test

### Full inpage test (URL given, or "test the widget on X")
1. Call navigate_to_store with the URL or store alias.
2. Call run_inpage_test — it auto-detects apparel / kids / bag / footwear / noVisor, opens the widget, completes onboarding, validates events, and runs a refresh. It returns { status, flow, store, productType }.
3. Call report_result with the outcome. Include flow type and store in the summary.

### Quick or targeted checks (e.g. "check events", "just open the widget")
1. Call navigate_to_store.
2. Call get_page_info to confirm the widget is present.
3. Use open_widget, complete_onboarding, check_events as needed.
4. Call report_result when done.

## Guidelines
- When the instruction is a URL or asks to "test"/"verify"/"check" a page end-to-end, ALWAYS use run_inpage_test — do not simulate the flow manually with individual tools.
- run_inpage_test accepts a phase: 'widget' (open only), 'onboarding' (open + form), 'full' (complete flow + refresh, default).
- If run_inpage_test returns status 'skipped', report as skipped with the reason.
- If any tool returns an error, try once to recover (wait and retry), then report as failed.
- ALWAYS call report_result as your final action — never end without it.
- When reporting events, list them clearly so they are easy to read in a Slack message.`;

// ── Test ──────────────────────────────────────────────────────────────────────

test(`Agent QA: ${INSTRUCTION}`, async ({ page }, testInfo) => {
  // Set up Virtusize watchers
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    document.hasFocus = () => true;
    window.findInShadow = (selector, root = document) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          const found = el.shadowRoot.querySelector(selector);
          if (found) return found;
          const nested = window.findInShadow(selector, el.shadowRoot);
          if (nested) return nested;
        }
      }
      return root.querySelector?.(selector) ?? null;
    };
    window.getWidgetHost = () =>
      document.querySelector("#router-view-wrapper") ||
      document.querySelector("#vs-aoyama")?.nextElementSibling;
  });

  await blockMarketingScripts(page);

  const eventWatcher = startVirtusizeEventWatcher(page);
  const pdc = startPDCWatcher(page);
  const recommendationAPI = startRecommendationWatcher(page);
  const bodyAPI = startBodyMeasurementWatcher(page);

  let currentUrl = null;
  let finalResult = null;

  // ── Tool implementations ──────────────────────────────────────────────────

  const executeTool = async (name, input) => {
    console.log(`[agent] tool: ${name}`, JSON.stringify(input));

    switch (name) {
      case "navigate_to_store": {
        const url = input.url || loadFallback(input.store_alias);
        if (!url) return { error: `No URL found for store '${input.store_alias}'. Try providing a direct url.` };
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForTimeout(2000);
          currentUrl = url;
          return { navigated_to: url };
        } catch (e) {
          return { error: `Navigation failed: ${e.message}` };
        }
      }

      case "get_page_info": {
        // Wait up to 20s for PDC to resolve
        const deadline = Date.now() + 20000;
        while (!pdc.store && Date.now() < deadline) {
          await page.waitForTimeout(500);
        }
        const widgetPresent = await page.evaluate(() =>
          !!(
            document.querySelector("#vs-inpage") ||
            document.querySelector("#vs-inpage-luxury") ||
            document.querySelector("#vs-legacy-inpage") ||
            document.querySelector("#router-view-wrapper")
          )
        );
        return {
          store: pdc.store || "unknown",
          productType: pdc.productType || "unknown",
          validProduct: pdc.validProduct,
          gender: pdc.gender,
          widgetPresent,
          url: currentUrl,
        };
      }

      case "open_widget": {
        const flow = input.flow || "apparel";
        try {
          if (flow === "luxury") {
            await page.waitForFunction(
              () => {
                const root = document.querySelector("#vs-inpage-luxury")?.shadowRoot;
                return !!root?.querySelector('[data-test-id="inpage-luxury-open-aoyama"]');
              },
              { timeout: 15000 }
            );
            await page.evaluate(() => {
              const root = document.querySelector("#vs-inpage-luxury")?.shadowRoot;
              root?.querySelector('[data-test-id="inpage-luxury-open-aoyama"]')?.click();
            });
          } else {
            await page.waitForFunction(
              () => {
                const root =
                  document.querySelector("#vs-inpage")?.shadowRoot ||
                  document.querySelector("#router-view-wrapper")?.shadowRoot;
                return !!root?.querySelector('[data-test-id="inpage-open-aoyama-btn"]');
              },
              { timeout: 15000 }
            );
            await page.evaluate(() => {
              const root =
                document.querySelector("#vs-inpage")?.shadowRoot ||
                document.querySelector("#router-view-wrapper")?.shadowRoot;
              root?.querySelector('[data-test-id="inpage-open-aoyama-btn"]')?.click();
            });
          }
          await page.waitForTimeout(2000);
          return { opened: true };
        } catch (e) {
          return { error: `Could not open widget: ${e.message}` };
        }
      }

      case "complete_onboarding": {
        try {
          await completeOnboarding(page);
          await page.waitForTimeout(3000);
          return { completed: true };
        } catch (e) {
          return { error: `Onboarding failed: ${e.message}` };
        }
      }

      case "check_events": {
        return { events: eventWatcher.getEvents() };
      }

      case "wait": {
        await page.waitForTimeout(Math.min(input.ms, 5000));
        return { waited_ms: Math.min(input.ms, 5000) };
      }

      case "take_screenshot": {
        const screenshot = await page.screenshot({ fullPage: false });
        await testInfo.attach(input.label, { body: screenshot, contentType: "image/png" });
        return { screenshot_attached: true, label: input.label };
      }

      case "run_inpage_test": {
        try {
          const result = await runInpageFlow(
            page,
            { pdc, eventWatcher, recommendationAPI, bodyAPI },
            {
              phase: input.phase || "full",
              url: currentUrl,
              BOT_PROTECTED_DOMAINS,
            },
          );
          console.log(`[agent] run_inpage_test: ${JSON.stringify(result)}`);
          return result;
        } catch (e) {
          return { status: "failed", error: e.message };
        }
      }

      case "report_result": {
        finalResult = input;
        console.log(`[agent] RESULT: ${input.status} — ${input.summary}`);
        return { acknowledged: true };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  };

  // ── Agent loop ────────────────────────────────────────────────────────────

  const messages = [
    { role: "user", content: INSTRUCTION },
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 20;

  try {
    while (!finalResult && iterations < MAX_ITERATIONS) {
      iterations++;

      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });

      // Add assistant response to messages
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "end_turn") {
        // Extract whatever Claude said as the summary
        const lastText = response.content
          .filter(b => b.type === "text")
          .map(b => b.text)
          .join("\n")
          .trim();
        finalResult = { status: "passed", summary: lastText || "Agent completed without explicit result." };
        break;
      }

      if (response.stop_reason !== "tool_use") break;

      // Execute all tool calls in this response
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const result = await executeTool(block.name, block.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });

        // Stop loop after report_result
        if (block.name === "report_result") break;
      }

      messages.push({ role: "user", content: toolResults });
    }
  } catch (loopError) {
    // Catch unhandled errors from the agent loop (e.g. Anthropic API failures,
    // Playwright test timeouts propagating through) so AGENT_RESULT is always logged.
    if (!finalResult) {
      finalResult = { status: "failed", summary: `Agent loop crashed: ${loopError.message}` };
    }
  }

  // ── Final assertion ───────────────────────────────────────────────────────

  if (!finalResult) {
    finalResult = { status: "failed", summary: "Agent hit iteration limit without reporting a result." };
  }

  // Always log AGENT_RESULT so the Slack notification step can find it.
  console.log(`\nAGENT_RESULT: ${JSON.stringify({ ...finalResult, url: currentUrl, instruction: INSTRUCTION })}`);

  if (finalResult.status === "failed") {
    throw new Error(finalResult.error || finalResult.summary);
  }
});
