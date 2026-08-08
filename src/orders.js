// Question packs paid in BTC.
//
// A user without their own API key can BUY questions: they pick a pack, the
// server locks a price (EUR -> sats at the live rate), the user pays from
// their own wallet, and the questions are credited ONLY when the payment is
// confirmed on-chain. Balances and order history are per PROVEN wallet
// address (BIP-322 sign-in) and persisted to disk.
//
// Free daily questions live in quota.js — a deliberately separate ledger, so
// "1 free per day" and "questions I paid for" never mix.
//
// Payment verification uses mempool.space (tx status + BTC/EUR price + fee
// estimates). The ordinals.com-recursive-only rule covers inscription data;
// payment tracking needs a chain/price API and ord provides neither.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.ORDERS_FILE || path.join(HERE, "..", ".questions.json");

// Where buyers send BTC. MUST be an address you control.
export const PAY_ADDRESS = process.env.PAY_ADDRESS || "34DXHZZebFcBkq5VsNDmMkVMNu7hWdRL14";
export const PACKS = [5, 10, 100];                                   // questions per pack
const EUR_PER_QUESTION = Number(process.env.EUR_PER_QUESTION) || 1;  // ~1 EUR per question
const MIN_CONFIRMATIONS = Number(process.env.MIN_CONFIRMATIONS) || 1;
const PAY_TOLERANCE = 0.98; // accept ≥98% of the quoted sats (rounding/wallet dust rules)

// SECRET promo codes live in the admin store (admin.js) — created and expired
// from the control panel, validated here, never sent to the client.
import { lookupPromo } from "./admin.js";
const normPromo = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

const MEMPOOL = (process.env.MEMPOOL_API || "https://mempool.space").replace(/\/$/, "");
const HEADERS = { "User-Agent": "bitmap-ai-chat", Accept: "application/json" };

// --- persistence ------------------------------------------------------------
let db = { balances: {}, orders: [] };
try {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  db = { balances: raw.balances || {}, orders: Array.isArray(raw.orders) ? raw.orders : [] };
  // history holds PAID orders only — drop anything never paid for (older
  // builds persisted the order at creation time, so a cancelled payment left
  // an "awaiting payment" row behind)
  const paid = db.orders.filter((o) => o.txid);
  if (paid.length !== db.orders.length) { db.orders = paid; setTimeout(() => persist(), 0); }
} catch { /* first run */ }

// Unpaid orders live in memory only. They become real (and persisted) the
// moment the wallet broadcasts a payment — so a cancelled purchase leaves
// nothing behind.
const drafts = new Map(); // id -> order
const DRAFT_TTL_MS = Number(process.env.QUOTE_TTL_MS) || 30 * 60_000; // how long a quoted price is held

function persist() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(db, null, 1));
  } catch (e) {
    console.error("orders: persist failed —", e?.message);
  }
}

// --- balances ---------------------------------------------------------------
export const getBalance = (addr) => db.balances[addr] || 0;

export function addQuestions(addr, n) {
  db.balances[addr] = getBalance(addr) + n;
  persist();
  return db.balances[addr];
}

// Spend one bought question. Returns true if one was available.
export function spendQuestion(addr) {
  if (getBalance(addr) <= 0) return false;
  db.balances[addr] -= 1;
  persist();
  return true;
}

// --- pricing ----------------------------------------------------------------
let priceCache = { at: 0, eur: 0 };
export async function btcEur() {
  if (priceCache.eur && Date.now() - priceCache.at < 5 * 60_000) return priceCache.eur;
  const res = await fetch(`${MEMPOOL}/api/v1/prices`, { headers: HEADERS });
  if (!res.ok) throw new Error(`price feed ${res.status}`);
  const j = await res.json();
  const eur = Number(j?.EUR);
  if (!Number.isFinite(eur) || eur <= 0) throw new Error("price feed returned no EUR rate");
  priceCache = { at: Date.now(), eur };
  return eur;
}

export async function feeRates() {
  try {
    const res = await fetch(`${MEMPOOL}/api/v1/fees/recommended`, { headers: HEADERS });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    return {
      fast: Math.max(1, Math.round(j.fastestFee)),
      medium: Math.max(1, Math.round(j.halfHourFee)),
      slow: Math.max(1, Math.round(j.hourFee ?? j.economyFee)),
    };
  } catch {
    return { fast: 12, medium: 6, slow: 3 }; // sane fallback; the wallet decides anyway
  }
}

// pack + promo -> price. Promo validity is returned as a boolean only: the
// client never learns which codes exist.
//
// A live code still has to have redemptions left — per wallet (perAddress,
// default 1) and overall (maxTotal, 0 = unlimited), both set in the admin
// panel. Out of redemptions = full price, with a reason for the UI.
export async function quote(pack, promoRaw, { address } = {}) {
  const questions = Number(pack);
  if (!PACKS.includes(questions)) throw Object.assign(new Error("unknown pack"), { code: 400 });
  const p = lookupPromo(promoRaw);
  let promoOk = !!p, promoUsed = false, promoExhausted = false;
  if (p) {
    const code = normPromo(promoRaw);
    if (p.maxTotal > 0 && promoUsesTotal(code) >= p.maxTotal) { promoOk = false; promoExhausted = true; }
    else if (p.perAddress > 0 && promoUsesBy(address, code) >= p.perAddress) { promoOk = false; promoUsed = true; }
  }
  const mult = promoOk ? p.mult : 1;
  const rate = await btcEur();
  const eurFull = questions * EUR_PER_QUESTION;
  const eur = Math.round(eurFull * mult * 100) / 100;
  const sats = Math.max(1000, Math.round((eur / rate) * 1e8)); // never below dust
  return {
    questions, eur, eurFull, sats, btcEur: rate,
    promoApplied: promoOk,
    promoUsed,                                       // valid code, this wallet has no uses left
    promoExhausted,                                  // valid code, nobody has uses left
    promoCode: promoOk ? normPromo(promoRaw) : null, // admin-only; stripped from buyer views
    discountPct: promoOk ? Math.round((1 - mult) * 100) : 0,
  };
}

// --- orders -----------------------------------------------------------------
// Buyer view: their own orders, without the promo code they used.
export function listOrders(addr) {
  return db.orders
    .filter((o) => o.address === addr)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50)
    .map(({ promoCode, ...o }) => o);
}

// Admin view: every order ever placed, promo codes included.
export function allOrders() {
  return [...db.orders].sort((a, b) => b.createdAt - a.createdAt);
}

// Redemptions are counted from the order history. Only orders that were
// actually paid count — a cancelled quote never reaches the history, and an
// underpaid or expired order doesn't burn the code (the buyer got nothing).
const redeemed = (o) => !!o.promoCode && o.status !== "underpaid" && o.status !== "expired";

// code -> redemptions across every buyer. This is the honest "how many times
// was it actually used" number the admin panel shows.
export function promoUseCounts() {
  const counts = {};
  for (const o of db.orders) if (redeemed(o)) counts[o.promoCode] = (counts[o.promoCode] || 0) + 1;
  return counts;
}

// A checkout in flight holds its discount: without this, two tabs could both
// quote at the discount and both pay before either order was saved. Cancelling
// (or letting the quote expire) releases it again.
function* liveDrafts() {
  const now = Date.now();
  for (const d of drafts.values()) if (now <= d.expiresAt && d.promoCode) yield d;
}

// Uses of this code by this address: paid + one checkout in flight.
export function promoUsesBy(address, code) {
  const c = normPromo(code);
  if (!c || !address) return 0;
  let n = db.orders.filter((o) => o.address === address && o.promoCode === c && redeemed(o)).length;
  for (const d of liveDrafts()) if (d.address === address && d.promoCode === c) n++;
  return n;
}

// Uses of this code by everyone: paid + checkouts in flight.
function promoUsesTotal(code) {
  const c = normPromo(code);
  let n = promoUseCounts()[c] || 0;
  for (const d of liveDrafts()) if (d.promoCode === c) n++;
  return n;
}

// Totals for the admin dashboard.
export function orderStats() {
  const paid = db.orders.filter((o) => o.credited);
  return {
    orders: db.orders.length,
    confirmed: paid.length,
    pending: db.orders.filter((o) => !o.credited && o.status === "pending").length,
    questionsSold: paid.reduce((s, o) => s + o.questions, 0),
    satsReceived: paid.reduce((s, o) => s + o.sats, 0),
    eurReceived: Math.round(paid.reduce((s, o) => s + o.eur, 0) * 100) / 100,
    buyers: new Set(paid.map((o) => o.address)).size,
    balancesOutstanding: Object.values(db.balances).reduce((s, n) => s + n, 0),
  };
}

// Creates a DRAFT (in memory, not saved). It only enters the history when the
// payment is broadcast — see attachTx.
export async function createOrder({ address, pack, promo }) {
  const q = await quote(pack, promo, { address }); // prices this buyer's remaining promo uses
  for (const [id, d] of drafts) if (Date.now() > d.expiresAt) drafts.delete(id); // prune
  const order = {
    id: "ord_" + crypto.randomBytes(8).toString("hex"),
    address,
    payTo: PAY_ADDRESS,
    questions: q.questions,
    eur: q.eur,
    sats: q.sats,
    btcEur: q.btcEur,
    promoApplied: q.promoApplied,
    promoCode: q.promoCode,
    discountPct: q.discountPct,
    status: "awaiting_payment",
    txid: null,
    confirmations: 0,
    credited: false,
    createdAt: Date.now(),
    expiresAt: Date.now() + DRAFT_TTL_MS, // the quoted sats are held this long
    note: null,
  };
  drafts.set(order.id, order);
  return order;
}

// The buyer backed out of the wallet dialog: drop the draft so its held promo
// use is free again immediately (instead of waiting for the quote to expire).
// Never touches a saved order — once paid, it stays.
export function cancelOrder(address, orderId) {
  const d = drafts.get(orderId);
  if (d && d.address === address) drafts.delete(orderId);
  return { cancelled: !!d };
}

// The wallet has broadcast a payment — this is the moment the order becomes
// real and enters the saved history.
export function attachTx(address, orderId, txid) {
  if (!/^[a-fA-F0-9]{64}$/.test(String(txid || ""))) throw Object.assign(new Error("that is not a transaction id"), { code: 400 });
  let order = db.orders.find((o) => o.id === orderId && o.address === address);
  const draft = order ? null : drafts.get(orderId);
  if (!order) {
    if (!draft || draft.address !== address) throw Object.assign(new Error("order not found — start the purchase again"), { code: 404 });
    if (Date.now() > draft.expiresAt) { drafts.delete(orderId); throw Object.assign(new Error("this quote expired — start the purchase again"), { code: 410 }); }
  }
  if (order?.credited) return order;
  // validate BEFORE saving, or a rejected txid would leave an unpaid order behind
  if (db.orders.some((o) => o.txid === txid && o.id !== orderId)) {
    throw Object.assign(new Error("that transaction is already used by another order"), { code: 409 });
  }
  if (draft) {
    drafts.delete(orderId);
    db.orders.push(draft);   // first time it is saved: the user actually paid
    order = draft;
  }
  order.txid = txid;
  order.status = "pending";
  order.paidAt = Date.now();
  persist();
  return order;
}

// Check one order against the chain. Credits questions exactly once.
async function checkOrder(order) {
  if (order.credited || !order.txid) return order;
  let tx;
  try {
    const res = await fetch(`${MEMPOOL}/api/tx/${order.txid}`, { headers: HEADERS });
    if (res.status === 404) return order;          // not seen yet — keep waiting
    if (!res.ok) return order;                     // transient — retry next tick
    tx = await res.json();
  } catch { return order; }

  const paid = (tx.vout || [])
    .filter((v) => v.scriptpubkey_address === order.payTo)
    .reduce((sum, v) => sum + (v.value || 0), 0);

  if (paid < Math.floor(order.sats * PAY_TOLERANCE)) {
    order.status = "underpaid";
    order.note = `paid ${paid} sats, expected ${order.sats}`;
    persist();
    return order;
  }

  if (!tx.status?.confirmed) {
    order.status = "pending";
    order.confirmations = 0;
    persist();
    return order;
  }

  // confirmed height known — derive confirmations from the tip
  let confirmations = 1;
  try {
    const tipRes = await fetch(`${MEMPOOL}/api/blocks/tip/height`, { headers: HEADERS });
    if (tipRes.ok) {
      const tip = Number(await tipRes.text());
      if (Number.isFinite(tip) && tx.status.block_height) confirmations = tip - tx.status.block_height + 1;
    }
  } catch { /* keep 1 */ }
  order.confirmations = Math.max(1, confirmations);

  if (order.confirmations >= MIN_CONFIRMATIONS) {
    order.status = "confirmed";
    order.credited = true;
    order.confirmedAt = Date.now();
    addQuestions(order.address, order.questions); // persists too
    console.log(`order ${order.id}: +${order.questions} questions for ${order.address} (tx ${order.txid})`);
  }
  persist();
  return order;
}

// Re-check every saved order that is still waiting on the chain.
export async function sweepOrders(addressFilter) {
  const todo = db.orders.filter((o) =>
    (!addressFilter || o.address === addressFilter) && o.txid && !o.credited);
  for (const o of todo) await checkOrder(o);
}

export function startOrderPoller(intervalMs = 60_000) {
  const tick = () => sweepOrders().catch((e) => console.error("order sweep:", e?.message));
  tick();
  const t = setInterval(tick, intervalMs);
  t.unref?.();
  return t;
}
