// Claude Opus 5 integration: streaming answers grounded in the crawled graph.
//
// Cost design: the big crawl context sits in the system prompt behind a
// cache_control breakpoint, so turn 2+ of a session reads it from the prompt
// cache at ~0.1x price instead of re-billing it. That only works if the
// serialized context is byte-identical across turns (context.js guarantees
// determinism; we also memoize per graph object).

import Anthropic from "@anthropic-ai/sdk";
import { serializeGraph } from "./context.js";
import { composeSystem } from "./prompt.js"; // house prompt + the reader's own

export const MODEL = "claude-opus-5";
// Models a BYOK visitor may choose (server-key requests always use MODEL).
// window = model context window; prices are $ per MTok (in/out) for the
// cost estimates (cache read bills 0.1x in, cache write 1.25x in).
export const MODELS = {
  "claude-opus-5":   { window: 1_000_000, inPrice: 5, outPrice: 25 },
  "claude-sonnet-5": { window: 1_000_000, inPrice: 3, outPrice: 15 },
  "claude-haiku-4-5": { window: 200_000, inPrice: 1, outPrice: 5 },
};
const CHAT_MAX_TOKENS = Number(process.env.CHAT_MAX_TOKENS) || 12_000;
const CONTEXT_TOKEN_BUDGET = Number(process.env.CONTEXT_TOKEN_BUDGET) || 200_000;

// BYOK: a visitor-supplied key (x-anthropic-key header) takes precedence over
// the server's env key, so a public deploy can run with NO server key and let
// every visitor spend their own money. Visitor keys are used per-request and
// never logged or stored. The env client stays lazy so the server can boot
// (and crawls can run) without any key at all.
let _envClient = null;
function clientFor(apiKey) {
  if (apiKey) return new Anthropic({ apiKey }); // per-request, never cached
  if (!process.env.ANTHROPIC_API_KEY) {
    const e = new Error("no API key available — open Settings (⚙) and paste your Anthropic API key");
    e.kind = "config";
    throw e;
  }
  if (!_envClient) _envClient = new Anthropic();
  return _envClient;
}

// serializeGraph is deterministic but not free — memoize per (graph, budget).
// Different budgets serialize differently, and prompt caching needs the exact
// same bytes per budget across turns.
const ctxCache = new WeakMap(); // graph -> Map(budget -> { text, estTokens, trimNotes })
export function contextFor(graph, budget = CONTEXT_TOKEN_BUDGET) {
  let per = ctxCache.get(graph);
  if (!per) { per = new Map(); ctxCache.set(graph, per); }
  let c = per.get(budget);
  if (!c) { c = serializeGraph(graph, budget); per.set(budget, c); }
  return c;
}

// -- daily spend guard -------------------------------------------------------
let day = "", dayTokens = 0;
function rollDay() {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) { day = d; dayTokens = 0; }
}
function recordTokens(usage) {
  rollDay();
  dayTokens += (usage?.input_tokens || 0) + (usage?.output_tokens || 0) +
    (usage?.cache_creation_input_tokens || 0) + (usage?.cache_read_input_tokens || 0);
}
export function overDailyLimit() {
  rollDay(); // must roll here too — once tripped, recordTokens never runs again
  const lim = Number(process.env.DAILY_TOKEN_LIMIT) || 0;
  return lim > 0 && dayTokens >= lim;
}

// Pricing per MTok from MODELS; cache read bills 0.1x input, cache write 1.25x.
// countDaily=false for visitor-key turns — they spend their own budget, so the
// server's DAILY_TOKEN_LIMIT must not count (or block) them.
export function logUsage(bitmap, turn, usage, { countDaily = true, model = MODEL } = {}) {
  if (!usage) return;
  if (countDaily) recordTokens(usage);
  const p = MODELS[model] || MODELS[MODEL];
  const cr = usage.cache_read_input_tokens || 0;
  const cw = usage.cache_creation_input_tokens || 0;
  const cost = (usage.input_tokens * p.inPrice + cr * p.inPrice * 0.1 + cw * p.inPrice * 1.25 + usage.output_tokens * p.outPrice) / 1e6;
  console.log(`chat bitmap=${bitmap} turn=${turn} model=${model} in=${usage.input_tokens} cache_read=${cr} cache_write=${cw} out=${usage.output_tokens} (~$${cost.toFixed(4)})`);
  if (turn >= 2 && cr === 0) {
    console.warn("chat: cache_read=0 on a follow-up turn — context serialization may not be deterministic, or >5min passed since the last turn");
  }
}

// startChat: kicks off the streaming request. Returns { abort, final } where
// final resolves to the SDK's final message (check stop_reason before use).
// apiKey (optional) is a visitor-supplied key used for this request only;
// model/contextBudget are validated+clamped by the route before they get here.
export function startChat({ graph, messages, onToken, apiKey, model = MODEL, contextBudget, userPrompts }) {
  const info = MODELS[model] || MODELS[MODEL];
  // leave headroom in the window for system prompt, history and the answer
  const budget = Math.min(contextBudget || CONTEXT_TOKEN_BUDGET, info.window - 50_000);
  const { text: ctx } = contextFor(graph, budget);

  const system = [
    // the admin's prompt, wrapped in whatever the reader added above/below it
    { type: "text", text: composeSystem(userPrompts) },
    { type: "text", text: `BITMAP CRAWL DATA:\n\n${ctx}`, cache_control: { type: "ephemeral" } },
  ];

  const msgs = [];
  const imageNodes = graph.includeImages ? graph.nodes.filter((n) => n.image) : [];
  if (imageNodes.length) {
    // synthetic user turn BEFORE history: consecutive user messages merge, and
    // keeping images first keeps the cacheable prefix stable across turns
    const content = imageNodes.flatMap((n) => [
      { type: "text", text: `Image inscription ${n.id} (#${n.number ?? "?"}, ${n.content_type}, kind: ${n.kind}):` },
      { type: "image", source: { type: "base64", media_type: n.image.media_type, data: n.image.base64 } },
    ]);
    content.push({
      type: "text",
      text: "The images above are the image inscriptions captured by the crawl (see [image attached to chat] markers in the data).",
      cache_control: { type: "ephemeral" },
    });
    msgs.push({ role: "user", content });
  }
  for (const m of messages) {
    msgs.push({ role: m.role, content: [{ type: "text", text: m.content }] });
  }
  // incremental multi-turn breakpoint on the newest message
  const lastContent = msgs[msgs.length - 1].content;
  lastContent[lastContent.length - 1].cache_control = { type: "ephemeral" };

  const c = clientFor(apiKey);
  const params = { model, max_tokens: CHAT_MAX_TOKENS, system, messages: msgs };
  // server-side refusal fallbacks are an Opus 5 feature — plain stream elsewhere
  const stream = model === "claude-opus-5"
    ? c.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
    : c.messages.stream(params);
  stream.on("text", onToken);

  return { abort: () => stream.abort(), final: stream.finalMessage() };
}

// Map SDK/config errors to { kind, message } safe to show in the UI.
export function chatErrorInfo(e, usedVisitorKey = false) {
  if (e?.kind === "config") return { kind: "config", message: e.message };
  if (e instanceof Anthropic.APIUserAbortError) return { kind: "aborted", message: "request aborted" };
  if (e instanceof Anthropic.AuthenticationError) {
    return {
      kind: "auth",
      message: usedVisitorKey
        ? "your Anthropic API key was rejected — check it in Settings (⚙)"
        : "the server's Anthropic API key was rejected — check ANTHROPIC_API_KEY",
    };
  }
  if (e instanceof Anthropic.RateLimitError) return { kind: "rate", message: "the AI is busy (rate limited) — try again in a moment" };
  if (e instanceof Anthropic.APIConnectionError) return { kind: "network", message: "could not reach the Anthropic API" };
  if (e instanceof Anthropic.APIError) return { kind: "api", message: `Anthropic API error ${e.status || ""}`.trim() };
  return { kind: "unknown", message: "chat failed unexpectedly" };
}
