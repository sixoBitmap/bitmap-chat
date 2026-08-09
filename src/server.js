// bitmap-ai-chat server: crawl progress + chat token streams over SSE,
// graph JSON for the visualization, static single-file frontend.

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { MAX_INDEXED_BITMAP } from "./oci.js";
import { getCrawl, getCachedGraph } from "./crawler.js";
import { startChat, chatErrorInfo, logUsage, overDailyLimit, contextFor, MODEL, MODELS } from "./chat.js";
import { freeUsedToday, useFree, refundFree } from "./quota.js";
import {
  getWalletScan, walletMayScan, isBitcoinAddress, GATE_BITMAP, freeAllowance, gateData,
  verifyScriber, promptRights, NO_PROMPT_RIGHTS,
} from "./wallet.js";
import { addClaim, claimIndex, removeClaim } from "./claims.js";
import { mountInscribe } from "./inscribe.js";
import { addBug, listBugs, deleteBug, bugStats, BUG_MAX } from "./bugs.js";
import { blockArt } from "./blockart.js";
import { makeChallenge, verifyChallenge, walletAuth } from "./auth.js";
import {
  PACKS, PAY_ADDRESS, quote, createOrder, attachTx, listOrders, sweepOrders,
  getBalance, addQuestions, spendQuestion, feeRates, startOrderPoller,
  allOrders, orderStats, promoUseCounts, cancelOrder,
} from "./orders.js";
import {
  adminEnabled, ADMIN_CODE, isAdmin, gateOwner, listAdmins, grantAdmin, revokeAdmin,
  listPromos, createPromo, setPromoActive, setPromoLimits, deletePromo, pathscriberHolders, describeHolders,
  registerScriber,
} from "./admin.js";
import { promptState, setPrompt, resetPrompt, systemPrompt, USER_PROMPT_MAX, USER_MAIN_MAX } from "./prompt.js";

// Wallet gate: users scan only their own bitmaps unless they hold a parcel /
// pathscribe of the gate bitmap. WALLET_GATE=0 disables (open access).
const WALLET_GATE = process.env.WALLET_GATE !== "0";
// context ceiling for FREE (server-key) questions; BYOK goes up to the model window
const FREE_CONTEXT_CAP = Number(process.env.FREE_CONTEXT_CAP) || 200_000;
const MARKET_URL = process.env.MARKET_URL ||
  "https://brc420.io/tokens/cd63a4c03b0091a7d4e6a30b98d15e0a15465bfaff08fac1e08dae0ae88b8462i0";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3100;
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("WARNING: ANTHROPIC_API_KEY is not set — crawling works, /api/chat will return a config error");
}

const app = express();
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "script-src": ["'self'", "'unsafe-inline'", "https://esm.sh", "https://cdn.jsdelivr.net"],
      "connect-src": ["'self'", "https://esm.sh", "https://cdn.jsdelivr.net"],
      "frame-src": ["https://ordinals.com", "https://brc420.io"], // brc420.io: in-page pathscribe marketplace
      "img-src": ["'self'", "data:", "https://ordinals.com"],
    },
  },
}));
app.use(express.json({ limit: "2mb" })); // history re-sends long assistant answers
app.use(walletAuth); // sets req.walletAddr from a valid BIP-322 session token

const crawlLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const chatLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false }));

// --- SSE helpers ------------------------------------------------------------
function sseHead(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
}
const sseSend = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function parseBitmap(raw) {
  if (!/^\d{1,6}$/.test(String(raw))) return null;
  const n = Number(raw);
  return n <= MAX_INDEXED_BITMAP ? n : null;
}

// --- routes -----------------------------------------------------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// UI status: does this deployment have its own key?
app.get("/api/config", (req, res) => res.json({
  serverHasKey: !!process.env.ANTHROPIC_API_KEY,
  walletGate: WALLET_GATE,
  gateBitmap: GATE_BITMAP,
  marketUrl: MARKET_URL,
  packs: PACKS,
  payTo: PAY_ADDRESS,
  maxBitmap: MAX_INDEXED_BITMAP, // how far the inscribed index reaches today
}));

// The house instructions, readable by anyone: the 📜 panel shows readers what
// the AI is told before their own additions. Read-only — only the admin edits.
app.get("/api/prompt", async (req, res) => res.json({
  text: systemPrompt(),
  userMax: USER_PROMPT_MAX,
  mainMax: USER_MAIN_MAX,
  gateBitmap: GATE_BITMAP,
  // which slots this wallet may write (empty for anyone not signed in)
  rights: req.walletAddr ? await promptRights(req.walletAddr) : NO_PROMPT_RIGHTS,
}));

const walletLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

// --- BIP-322 sign-in (btcmail pattern) --------------------------------------
// 1) challenge: a one-time message the wallet must sign
app.post("/api/auth/challenge", walletLimiter, (req, res) => {
  const address = String(req.body?.address || "").trim();
  if (!isBitcoinAddress(address)) return res.status(400).json({ error: "that doesn't look like a Bitcoin address" });
  res.json(makeChallenge(address));
});
// 2) verify: BIP-322 signature -> session token; the address is now PROVEN
app.post("/api/auth/verify", walletLimiter, (req, res) => {
  const out = verifyChallenge(req.body?.nonce, req.body?.signature);
  if (out.error) return res.status(401).json({ error: out.error });
  res.json(out);
});
// 3) session check: lets the UI verify a stored token is still valid on boot
app.get("/api/auth/session", (req, res) => {
  if (req.walletAddr) return res.json({ address: req.walletAddr });
  res.status(401).json({ error: req.walletAuthFailed ? "wallet session expired — sign in again" : "not signed in" });
});

// Scan the SIGNED-IN wallet: canonical bitmaps + PathScribers + gate parcels.
// fresh=1 forces a re-scan (after minting/buying a PathScriber).
app.post("/api/wallet/scan", walletLimiter, async (req, res) => {
  if (!req.walletAddr) return res.status(401).json({ error: req.walletAuthFailed ? "wallet session expired — sign in again" : "sign in with your wallet first" });
  try {
    const scan = await getWalletScan(req.walletAddr, { fresh: req.query.fresh === "1" });
    res.json(scan);
  } catch (e) {
    console.error("wallet scan:", e?.message || e);
    res.status(502).json({ error: "wallet scan failed — try again shortly" });
  }
});

// "I minted a PathScriber, here is its inscription id." Checks the content AND
// that this wallet owns it, then re-scans so the unlock and the extra free
// question apply straight away. The claim is only a pointer — every later scan
// re-verifies it, so selling the PathScriber ends the access.
app.post("/api/wallet/pathscriber", walletLimiter, async (req, res) => {
  if (needWallet(req, res)) return;
  const id = String(req.body?.id || "").trim().toLowerCase()
    .replace(/^.*\/(?:inscription|content)\//, "")   // tolerate a pasted ordinals.com link
    .replace(/[?#].*$/, "");
  const claimed = /^[a-f0-9]{64}$/.test(id) ? `${id}i0` : id; // a bare reveal txid means i0
  const v = await verifyScriber(claimed, req.walletAddr);
  if (!v.ok) return res.status(400).json({ error: v.reason });
  addClaim(req.walletAddr, v.id);
  registerScriber(v.id);                                       // shows up in the admin panel
  console.log(`pathscriber claimed: ${v.id} by ${req.walletAddr}`);
  try {
    res.json({ ok: true, pathscriber: { id: v.id, number: v.number }, scan: await getWalletScan(req.walletAddr, { fresh: true }) });
  } catch {
    res.json({ ok: true, pathscriber: { id: v.id, number: v.number }, scan: null });
  }
});

// Shared gate for crawl/graph/chat: ONLY the proven token address counts.
// An expired/invalid token gets a DISTINCT message so the UI can reset itself
// instead of showing a signed-in wallet that every request refuses.
async function gateCheck(req, bitmap) {
  if (!WALLET_GATE) return { ok: true };
  if (!req.walletAddr) {
    return { ok: false, reason: req.walletAuthFailed ? "wallet session expired — sign in again" : "sign in with your wallet first" };
  }
  // A question credit is FULL ACCESS: today's free question (a gift to
  // everyone who signs in, even with an empty wallet) or a bought question
  // opens ANY bitmap. Ownership / PathScriber decide only when there is no
  // credit left.
  if (await hasCredit(req.walletAddr)) return { ok: true };
  return walletMayScan(req.walletAddr, bitmap);
}

// free questions left today = allowance (1 + PathScribers + parcels) − used
async function freeLeftFor(addr) {
  if (!addr) return 0;
  return Math.max(0, (await freeAllowance(addr)) - freeUsedToday(addr));
}
// does this address have a question it could spend right now?
async function hasCredit(addr) {
  if (!addr) return false;
  return getBalance(addr) > 0 || (await freeLeftFor(addr)) > 0;
}

// Crawl (or join a crawl in progress) with live progress. Ends after
// `ready` or `error`; the graph itself is fetched from /api/graph.
app.get("/api/crawl/:bitmap", crawlLimiter, async (req, res) => {
  const n = parseBitmap(req.params.bitmap);
  if (n === null) return res.status(400).json({ error: `bitmap must be a number 0-${MAX_INDEXED_BITMAP} (on-chain index coverage)` });
  const gate = await gateCheck(req, n);
  if (!gate.ok) return res.status(403).json({ error: gate.reason });
  const images = req.query.images === "1";

  sseHead(res);
  const job = getCrawl(n, images);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  const cb = (event, payload) => {
    sseSend(res, event, payload);
    if (event === "ready" || event === "error") { cleanup(); res.end(); }
  };
  const cleanup = () => { clearInterval(ping); job.unsubscribe(cb); };
  req.on("close", cleanup);
  job.subscribe(cb); // replays current state; fires ready immediately if cached
});

// Crawled graph for the visualization (image payloads stripped — the browser
// previews /content/<id> itself via ordinals.com iframes).
app.get("/api/graph/:bitmap", async (req, res) => {
  const n = parseBitmap(req.params.bitmap);
  if (n === null) return res.status(400).json({ error: "bad bitmap number" });
  const gate = await gateCheck(req, n);
  if (!gate.ok) return res.status(403).json({ error: gate.reason });
  const graph = getCachedGraph(n, req.query.images === "1");
  if (!graph) return res.status(409).json({ error: "not crawled (or crawl expired) — run the crawl first" });
  res.json({
    bitmap: graph.bitmap,
    rootId: graph.rootId,
    includeImages: graph.includeImages,
    crawledAt: graph.crawledAt,
    stats: graph.stats,
    edges: graph.edges,
    nodes: graph.nodes.map(({ image, text, ...rest }) => ({
      ...rest,
      hasImage: !!image,
      text: text != null && text.length <= 2000 ? text : text != null ? text.slice(0, 2000) + "…" : null,
    })),
  });
});

// Chat: full history in, assistant tokens out (SSE).
app.post("/api/chat", chatLimiter, async (req, res) => {
  const { bitmap, images, messages } = req.body || {};
  const n = parseBitmap(bitmap);
  if (n === null) return res.status(400).json({ error: "bad bitmap number" });
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
    return res.status(400).json({ error: "messages must be a non-empty array of at most 40 turns" });
  }
  for (const m of messages) {
    // assistant turns are Claude's own replies (CHAT_MAX_TOKENS ~12k tokens ≈ up
    // to ~48k chars) — capping them like user input would brick the chat history
    const max = m?.role === "assistant" ? 60_000 : 8_000;
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || m.content.length === 0 || m.content.length > max) {
      return res.status(400).json({ error: "each message needs role user|assistant and content (user ≤8000 chars, assistant ≤60000)" });
    }
  }
  if (messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ error: "the last message must be from the user" });
  }
  // The reader's own instructions, wrapped around the house prompt (📜 in the
  // header). Above outranks the house prompt, below is the lowest priority.
  //
  // WHO MAY WRITE WHERE — enforced here, not in the UI: a PathScriber buys the
  // top slot, a gate-bitmap parcel the bottom one, both together the middle
  // (that reader's own copy of the house prompt). Checked BEFORE any charge.
  const userPrompts = {
    above: String(req.body?.promptAbove || ""),
    below: String(req.body?.promptBelow || ""),
    main: String(req.body?.promptMain || ""),
  };
  const SLOTS = {
    above: { label: "top", max: USER_PROMPT_MAX, need: `a PathScriber` },
    below: { label: "bottom", max: USER_PROMPT_MAX, need: `a ${GATE_BITMAP}.bitmap parcel` },
    main: { label: "middle", max: USER_MAIN_MAX, need: `both a PathScriber and a ${GATE_BITMAP}.bitmap parcel` },
  };
  if (Object.values(userPrompts).some((t) => t.trim())) {
    const rights = req.walletAddr ? await promptRights(req.walletAddr) : NO_PROMPT_RIGHTS;
    for (const [slot, text] of Object.entries(userPrompts)) {
      if (!text.trim()) continue;
      const { label, max, need } = SLOTS[slot];
      if (text.length > max) {
        return res.status(400).json({ error: `your ${label} instructions are too long (${text.length} of ${max} characters)` });
      }
      if (!rights[slot]) {
        return res.status(403).json({ kind: "prompt", error: `the ${label} instructions need ${need} in your wallet` });
      }
    }
  }
  // BYOK: a visitor-supplied key rides the x-anthropic-key header. Shape-check
  // only (never logged, never stored); it takes precedence over the env key.
  const visitorKey = String(req.get("x-anthropic-key") || "").trim();
  if (visitorKey && !/^sk-ant-[A-Za-z0-9_-]{20,250}$/.test(visitorKey)) {
    return res.status(400).json({ error: "that doesn't look like an Anthropic API key (sk-ant-…) — check Settings" });
  }
  // WHO PAYS — decided (but not charged) before anything else, so an
  // out-of-questions user gets that message instead of an access error.
  const payer = { addr: null, from: null }; // from: "free" | "balance"
  if (!visitorKey) {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(402).json({ kind: "config", error: "this server has no API key — add your own in Settings (⚙) to chat" });
    }
    if (!req.walletAddr) return res.status(401).json({ error: "sign in with your wallet first" });
    payer.addr = req.walletAddr;
    if ((await freeLeftFor(payer.addr)) > 0) payer.from = "free";
    else if (getBalance(payer.addr) > 0) payer.from = "balance";
    else {
      return res.status(402).json({
        kind: "quota",
        error: "you've used your free questions for today and have none left — buy questions in Settings (⚙), or add your own API key for unlimited",
      });
    }
  }

  const gate = await gateCheck(req, n);
  if (!gate.ok) return res.status(403).json({ error: gate.reason });
  const graph = getCachedGraph(n, !!images);
  if (!graph) return res.status(409).json({ error: "crawl expired or missing — run the crawl again first" });
  // the daily cap protects the SERVER's key only — visitor keys spend their own budget
  if (!visitorKey && overDailyLimit()) return res.status(429).json({ error: "daily token limit reached — try again tomorrow, or add your own API key in Settings" });

  // Model + context budget. BYOK visitors choose both; free (server-key)
  // questions always run the default model with a capped context.
  const reqBudget = Number(req.body?.contextBudget) || 0;
  let model = MODEL;
  let contextBudget;
  if (visitorKey) {
    const m = String(req.body?.model || MODEL);
    if (!MODELS[m]) return res.status(400).json({ error: "unknown model — pick one from Settings" });
    model = m;
    contextBudget = Math.min(Math.max(reqBudget || 200_000, 10_000), MODELS[m].window);
  } else {
    contextBudget = Math.min(Math.max(reqBudget || FREE_CONTEXT_CAP, 10_000), FREE_CONTEXT_CAP);
  }

  // CHARGE NOW (the free question first, then the bought balance). Whatever
  // is taken is given back if the answer never arrives.
  if (payer.from === "free") useFree(payer.addr);
  else if (payer.from === "balance" && !spendQuestion(payer.addr)) {
    return res.status(402).json({ kind: "quota", error: "you have no questions left — buy questions in Settings (⚙)" });
  }
  const refundQuestion = () => {
    if (payer.from === "free") refundFree(payer.addr);
    else if (payer.from === "balance") addQuestions(payer.addr, 1);
    payer.from = null;
  };

  sseHead(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  let chat = null;
  let closed = false;
  req.on("close", () => { closed = true; clearInterval(ping); try { chat?.abort(); } catch {} });

  try {
    chat = startChat({
      graph, messages, apiKey: visitorKey || undefined, model, contextBudget, userPrompts,
      onToken: (t) => { if (!closed) sseSend(res, "token", { text: t }); },
    });
    const final = await chat.final;
    if (final.stop_reason === "refusal") {
      refundQuestion(); // they got nothing — don't charge them
      sseSend(res, "error", { kind: "refusal", message: "Claude declined this request." });
    } else {
      const u = final.usage || {};
      sseSend(res, "usage", {
        model: final.model || model,
        window: (MODELS[model] || MODELS[MODEL]).window,
        charged: payer.from,                                          // "free" | "balance" | null
        free_question: payer.from === "free",
        free_left: payer.addr ? await freeLeftFor(payer.addr) : null,
        questions_left: payer.addr ? getBalance(payer.addr) : null,
        input_tokens: u.input_tokens || 0,
        cache_read_input_tokens: u.cache_read_input_tokens || 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
        output_tokens: u.output_tokens || 0,
      });
      sseSend(res, "done", { stop_reason: final.stop_reason });
    }
    logUsage(n, Math.ceil(messages.length / 2), final.usage, { countDaily: !visitorKey, model });
  } catch (e) {
    refundQuestion(); // a failed question must never be charged
    const info = chatErrorInfo(e, !!visitorKey);
    if (info.kind !== "aborted") {
      console.error(`chat error (${info.kind}):`, e?.message || e);
      if (!closed) sseSend(res, "error", info);
    }
  } finally {
    clearInterval(ping);
    if (!closed) res.end();
  }
});

// Quota + model info for the UI (Settings + usage popup).
app.get("/api/quota", async (req, res) => {
  res.json({
    serverHasKey: !!process.env.ANTHROPIC_API_KEY,
    signedIn: !!req.walletAddr,
    freeUsed: req.walletAddr ? freeUsedToday(req.walletAddr) : null,
    freeAllowance: req.walletAddr ? await freeAllowance(req.walletAddr) : null,
    freeLeft: req.walletAddr ? await freeLeftFor(req.walletAddr) : null,
    questions: req.walletAddr ? getBalance(req.walletAddr) : 0,
    freeContextCap: FREE_CONTEXT_CAP,
    models: Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, { window: m.window, inPrice: m.inPrice, outPrice: m.outPrice }])),
  });
});

// --- buying questions with BTC ----------------------------------------------
const orderLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const needWallet = (req, res) => {
  if (req.walletAddr) return false;
  res.status(401).json({ error: req.walletAuthFailed ? "wallet session expired — sign in again" : "sign in with your wallet first" });
  return true;
};

// Live price for a pack (+ optional secret promo code). No wallet needed — but
// if the caller IS signed in we price for THAT address, so a code they have
// already redeemed shows as spent here instead of surprising them at checkout.
app.get("/api/orders/quote", orderLimiter, async (req, res) => {
  try {
    const { promoCode, ...q } = await quote(Number(req.query.pack), req.query.promo, { address: req.walletAddr });
    res.json(q); // the code itself stays server-side
  } catch (e) {
    res.status(e.code || 502).json({ error: e.code ? e.message : "could not fetch the BTC price — try again" });
  }
});

// A district drawn as its block's transactions. Computed once per block and
// cached forever (blocks don't change), so this is cheap after the first hit.
const artLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 400, standardHeaders: true, legacyHeaders: false });
app.get("/api/block/:height/art", artLimiter, async (req, res) => {
  try {
    const art = await blockArt(req.params.height);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.json(art);
  } catch (e) {
    res.status(e.code || 502).json({ error: e.code ? e.message : "could not read that block right now" });
  }
});

// Report a bug. The reporter sends only text — the address comes from their
// proven session, so nobody can file a report as somebody else.
const bugLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
app.post("/api/bugs", bugLimiter, (req, res) => {
  if (needWallet(req, res)) return;
  try { const b = addBug(req.walletAddr, req.body?.text); res.json({ ok: true, id: b.id, max: BUG_MAX }); }
  catch (e) { res.status(e.code || 500).json({ error: e.message || "could not save that" }); }
});

// Chain reads, coin lookup and broadcast for the in-page inscribe tool.
mountInscribe(app, { requireWallet: needWallet });

// Recommended network fees (guidance; the wallet sets the final fee).
app.get("/api/fees", orderLimiter, async (req, res) => res.json(await feeRates()));

// Balance + order history for the signed-in wallet. ?refresh=1 re-checks chain.
app.get("/api/orders", orderLimiter, async (req, res) => {
  if (needWallet(req, res)) return;
  if (req.query.refresh === "1") await sweepOrders(req.walletAddr).catch(() => {});
  res.json({
    address: req.walletAddr,
    questions: getBalance(req.walletAddr),
    freeLeft: await freeLeftFor(req.walletAddr),
    freeAllowance: await freeAllowance(req.walletAddr),
    payTo: PAY_ADDRESS,
    packs: PACKS,
    orders: listOrders(req.walletAddr),
  });
});

// Create an order: locks the price in sats for this purchase.
app.post("/api/orders", orderLimiter, async (req, res) => {
  if (needWallet(req, res)) return;
  try {
    const order = await createOrder({ address: req.walletAddr, pack: Number(req.body?.pack), promo: req.body?.promo });
    res.json(order);
  } catch (e) {
    res.status(e.code || 502).json({ error: e.code ? e.message : "could not create the order — try again" });
  }
});

// The buyer cancelled in their wallet — release the (unsaved) draft, so a promo
// code held by this checkout becomes usable again right away.
app.delete("/api/orders/:id", orderLimiter, (req, res) => {
  if (needWallet(req, res)) return;
  res.json(cancelOrder(req.walletAddr, req.params.id));
});

// The wallet broadcast the payment — record its txid and start watching it.
app.post("/api/orders/:id/tx", orderLimiter, async (req, res) => {
  if (needWallet(req, res)) return;
  try {
    const order = attachTx(req.walletAddr, req.params.id, req.body?.txid);
    sweepOrders(req.walletAddr).catch(() => {}); // check immediately, don't block
    res.json(order);
  } catch (e) {
    res.status(e.code || 400).json({ error: e.message });
  }
});

// Debug: inspect the exact context Claude receives (size sanity check).
app.get("/api/context/:bitmap", (req, res) => {
  const n = parseBitmap(req.params.bitmap);
  const graph = n === null ? null : getCachedGraph(n, req.query.images === "1");
  if (!graph) return res.status(409).json({ error: "not crawled" });
  const c = contextFor(graph);
  res.type("text/plain").send(`# est ${c.estTokens} tokens, trims: ${c.trimNotes.join("; ") || "none"}\n\n${c.text}`);
});

// --- admin control panel ----------------------------------------------------
// Every admin call needs BOTH: a proven wallet (BIP-322 session) that owns the
// gate bitmap or was granted access, AND the secret admin code.
const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });

async function requireAdmin(req, res, next) {
  if (!adminEnabled()) return res.status(404).json({ error: "admin panel is not enabled on this server" });
  const code = String(req.get("x-admin-code") || "");
  const want = Buffer.from(ADMIN_CODE);
  const got = Buffer.from(code);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return res.status(401).json({ error: "wrong admin code" });
  }
  if (!req.walletAddr) return res.status(401).json({ error: "sign in with your wallet first" });
  if (!(await isAdmin(req.walletAddr))) {
    return res.status(403).json({ error: `only the wallet holding ${GATE_BITMAP}.bitmap (or an address it granted) can open the panel` });
  }
  next();
}

// Is the panel available at all? (no secrets in the answer)
app.get("/api/admin/enabled", (req, res) => res.json({ enabled: adminEnabled(), gateBitmap: GATE_BITMAP }));

// Login probe — the panel calls this to check code + wallet before showing anything.
app.post("/api/admin/login", adminLimiter, requireAdmin, async (req, res) => {
  res.json({ ok: true, address: req.walletAddr, owner: await gateOwner().catch(() => null), admins: listAdmins() });
});

// Each code carries how many times it has been redeemed (one per address).
const promosWithUses = () => {
  const counts = promoUseCounts();
  return listPromos().map((p) => ({ ...p, uses: counts[p.code] || 0 }));
};

// Dashboard: totals + promos + admins.
app.get("/api/admin/overview", adminLimiter, requireAdmin, async (req, res) => {
  res.json({
    stats: orderStats(),
    promos: promosWithUses(),
    admins: listAdmins(),
    owner: await gateOwner().catch(() => null),
    payTo: PAY_ADDRESS,
    gateBitmap: GATE_BITMAP,
  });
});

// Every order ever placed, with the promo code used and buyer address.
app.get("/api/admin/orders", adminLimiter, requireAdmin, async (req, res) => {
  if (req.query.refresh === "1") await sweepOrders().catch(() => {});
  res.json({ orders: allOrders(), stats: orderStats() });
});

// PathScribers and their current owners, plus who claimed each one by hand.
const withClaims = (d) => {
  const idx = claimIndex();
  return { ...d, rows: d.rows.map((r) => ({ ...r, claim: idx[r.id] || null })) };
};
app.get("/api/admin/pathscribers", adminLimiter, requireAdmin, async (req, res) => {
  try { res.json(withClaims(await pathscriberHolders())); }
  catch (e) { res.status(502).json({ error: e?.message || "could not read holders" }); }
});
app.post("/api/admin/pathscribers", adminLimiter, requireAdmin, async (req, res) => {
  const id = String(req.body?.id || "").trim();
  if (!/^[a-f0-9]{64}i\d+$/i.test(id)) return res.status(400).json({ error: "that is not an inscription id" });
  registerScriber(id);
  res.json(withClaims(await pathscriberHolders()));
});
// Drop a holder's manual claim (the mint itself stays in the registry).
app.delete("/api/admin/pathscribers/:id/claim", adminLimiter, requireAdmin, async (req, res) => {
  removeClaim(decodeURIComponent(req.params.id));
  res.json(withClaims(await pathscriberHolders()));
});

// 114588 parcels and their current owners.
app.get("/api/admin/parcels", adminLimiter, requireAdmin, async (req, res) => {
  try {
    const g = await gateData();
    const ids = [...g.parcelById.keys()];
    const rows = (await describeHolders(ids)).map((r) => ({ ...r, parcel: g.parcelById.get(r.id)?.text || null }));
    rows.sort((a, b) => (g.parcelById.get(a.id)?.x ?? 0) - (g.parcelById.get(b.id)?.x ?? 0));
    res.json({ gateBitmap: GATE_BITMAP, txCount: g.txCount, minted: rows.length, holders: new Set(rows.map((r) => r.owner).filter(Boolean)).size, rows });
  } catch (e) { res.status(502).json({ error: e?.message || "could not read parcels" }); }
});

// Promo codes.
app.post("/api/admin/promos", adminLimiter, requireAdmin, (req, res) => {
  try { createPromo(req.body || {}); res.json({ promos: promosWithUses() }); }
  catch (e) { res.status(e.code || 400).json({ error: e.message }); }
});
app.post("/api/admin/promos/:code/active", adminLimiter, requireAdmin, (req, res) => {
  try { setPromoActive(decodeURIComponent(req.params.code), !!req.body?.active); res.json({ promos: promosWithUses() }); }
  catch (e) { res.status(e.code || 400).json({ error: e.message }); }
});
// How many times a code may be redeemed: per wallet, and in total (0 = ∞).
app.post("/api/admin/promos/:code/limits", adminLimiter, requireAdmin, (req, res) => {
  try {
    setPromoLimits(decodeURIComponent(req.params.code), {
      perAddress: req.body?.perAddress,
      maxTotal: req.body?.maxTotal,
    });
    res.json({ promos: promosWithUses() });
  } catch (e) { res.status(e.code || 400).json({ error: e.message }); }
});
app.delete("/api/admin/promos/:code", adminLimiter, requireAdmin, (req, res) => {
  deletePromo(decodeURIComponent(req.params.code));
  res.json({ promos: promosWithUses() });
});

// The instructions Claude answers by. Editing takes effect on the next
// question — no restart — and invalidates the prompt cache once.
app.get("/api/admin/prompt", adminLimiter, requireAdmin, (req, res) => res.json(promptState()));
app.post("/api/admin/prompt", adminLimiter, requireAdmin, (req, res) => {
  try { res.json(setPrompt(req.body?.text)); }
  catch (e) { res.status(e.code || 500).json({ error: e.message || "could not save the prompt" }); }
});
app.delete("/api/admin/prompt", adminLimiter, requireAdmin, (req, res) => res.json(resetPrompt()));

// Bug reports — admins read and delete them; nobody else can see them at all.
app.get("/api/admin/bugs", adminLimiter, requireAdmin, (req, res) =>
  res.json({ bugs: listBugs(), stats: bugStats() }));
app.delete("/api/admin/bugs/:id", adminLimiter, requireAdmin, (req, res) => {
  deleteBug(decodeURIComponent(req.params.id));
  res.json({ bugs: listBugs(), stats: bugStats() });
});

// Who else may open the panel.
app.post("/api/admin/admins", adminLimiter, requireAdmin, (req, res) => {
  try { res.json({ admins: grantAdmin(String(req.body?.address || "").trim()) }); }
  catch (e) { res.status(e.code || 400).json({ error: e.message }); }
});
app.delete("/api/admin/admins/:address", adminLimiter, requireAdmin, (req, res) => {
  res.json({ admins: revokeAdmin(decodeURIComponent(req.params.address)) });
});

// --- static frontend + tail -------------------------------------------------
app.use(express.static(path.join(__dirname, "..", "web"), {
  setHeaders(res, file) {
    if (file.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
  },
}));
app.use((req, res) => res.status(404).json({ error: "not found" }));
app.use((err, req, res, next) => {
  console.error("unhandled:", err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: "internal error" });
});

startOrderPoller(); // watches pending payments and credits confirmed ones
app.listen(PORT, () => console.log(`bitmap-ai-chat listening on http://localhost:${PORT}`));
process.on("SIGTERM", () => process.exit(0));
