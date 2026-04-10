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

test.setTimeout(180000);

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
1. Call navigate_to_store to go to the product page.
2. Call get_page_info to confirm the product is valid and the widget is present.
3. If the task involves opening the widget, call open_widget.
4. If the task involves onboarding, call complete_onboarding after the widget is open.
5. Call check_events to verify expected analytics events fired.
6. Take a screenshot of key moments.
7. Call report_result when done.

## Guidelines
- Always call get_page_info after navigating to confirm the page loaded correctly.
- If get_page_info shows validProduct is false or undefined after 30s, report as skipped.
- If any tool returns an error, try once to recover (e.g. wait and retry), then report as failed.
- Keep the test focused on what the instruction asks. Don't over-test.
- ALWAYS call report_result as your final action — never end without it.
- When the instruction asks about events, call check_events and include the full event list in the summary, one event per line.
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
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(2000);
        currentUrl = url;
        return { navigated_to: url };
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

  // ── Final assertion ───────────────────────────────────────────────────────

  if (!finalResult) {
    finalResult = { status: "failed", summary: "Agent hit iteration limit without reporting a result." };
  }

  console.log(`\nAGENT_RESULT: ${JSON.stringify({ ...finalResult, url: currentUrl, instruction: INSTRUCTION })}`);

  if (finalResult.status === "failed") {
    throw new Error(finalResult.error || finalResult.summary);
  }
});
