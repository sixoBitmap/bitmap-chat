// Question packs: pricing, the secret promo, and — most importantly — that
// questions are credited ONLY for a confirmed, sufficient, on-chain payment.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const file = path.join(os.tmpdir(), `bac-orders-test-${process.pid}.json`);
const adminFile = path.join(os.tmpdir(), `bac-admin-test-${process.pid}.json`);
process.env.ORDERS_FILE = file;
process.env.ADMIN_FILE = adminFile;   // keep the real promo store out of the tests
process.env.PAY_ADDRESS = "34DXHZZebFcBkq5VsNDmMkVMNu7hWdRL14";
const PAY_TO = process.env.PAY_ADDRESS;
const ADDR = "bc1qbuyer000000000000000000000000000000000";

// stub the network: price feed + tx lookups
let TX = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/api/v1/prices")) return new Response(JSON.stringify({ EUR: 100000 }), { status: 200 });
  if (u.includes("/api/blocks/tip/height")) return new Response("900100", { status: 200 });
  const m = u.match(/\/api\/tx\/([a-f0-9]{64})/);
  if (m) return TX[m[1]] ? new Response(JSON.stringify(TX[m[1]]), { status: 200 }) : new Response("not found", { status: 404 });
  return realFetch(url);
};

const O = await import("../src/orders.js");
const A = await import("../src/admin.js");
const txid = (c) => c.repeat(64);

// pay for an order in full and confirm it, so the promo counts as redeemed
async function payFor(addr, pack, promo, tx) {
  const order = await O.createOrder({ address: addr, pack, promo });
  TX[tx] = { vout: [{ scriptpubkey_address: PAY_TO, value: order.sats }], status: { confirmed: true, block_height: 900100 } };
  O.attachTx(addr, order.id, tx);
  await O.sweepOrders(addr);
  return order;
}

test("pricing: ~1 EUR per question, converted live to sats", async () => {
  const q = await O.quote(10);
  assert.equal(q.questions, 10);
  assert.equal(q.eur, 10);                    // 10 questions * 1 EUR
  assert.equal(q.sats, Math.round((10 / 100000) * 1e8)); // 10000 sats at 100k EUR/BTC
  assert.equal(q.promoApplied, false);
});

test("secret promo code gives 50% off; wrong codes silently don't", async () => {
  const ok = await O.quote(10, "  Be The Bitmap ");   // case/space tolerant
  assert.equal(ok.promoApplied, true);
  assert.equal(ok.discountPct, 50);
  assert.equal(ok.eur, 5);
  const bad = await O.quote(10, "freequestions");
  assert.equal(bad.promoApplied, false);
  assert.equal(bad.eur, 10);
});

test("unknown pack sizes are rejected", async () => {
  await assert.rejects(() => O.quote(7), /unknown pack/);
});

test("a confirmed, fully-paid tx credits the questions exactly once", async () => {
  const order = await O.createOrder({ address: ADDR, pack: 5 });
  assert.equal(order.status, "awaiting_payment");
  assert.equal(O.getBalance(ADDR), 0);

  TX[txid("a")] = { vout: [{ scriptpubkey_address: PAY_TO, value: order.sats }], status: { confirmed: true, block_height: 900100 } };
  O.attachTx(ADDR, order.id, txid("a"));
  await O.sweepOrders(ADDR);
  assert.equal(O.getBalance(ADDR), 5, "questions credited on confirmation");

  await O.sweepOrders(ADDR); // idempotent — must not double-credit
  assert.equal(O.getBalance(ADDR), 5);
  assert.equal(O.listOrders(ADDR)[0].status, "confirmed");
});

test("an UNCONFIRMED tx credits nothing yet", async () => {
  const addr = ADDR + "2";
  const order = await O.createOrder({ address: addr, pack: 5 });
  TX[txid("b")] = { vout: [{ scriptpubkey_address: PAY_TO, value: order.sats }], status: { confirmed: false } };
  O.attachTx(addr, order.id, txid("b"));
  await O.sweepOrders(addr);
  assert.equal(O.getBalance(addr), 0, "must wait for a confirmation");
  assert.equal(O.listOrders(addr)[0].status, "pending");
});

test("an UNDERPAID tx credits nothing and is flagged", async () => {
  const addr = ADDR + "3";
  const order = await O.createOrder({ address: addr, pack: 10 });
  TX[txid("c")] = { vout: [{ scriptpubkey_address: PAY_TO, value: Math.floor(order.sats / 2) }], status: { confirmed: true, block_height: 900100 } };
  O.attachTx(addr, order.id, txid("c"));
  await O.sweepOrders(addr);
  assert.equal(O.getBalance(addr), 0);
  assert.equal(O.listOrders(addr)[0].status, "underpaid");
});

test("paying a DIFFERENT address credits nothing", async () => {
  const addr = ADDR + "4";
  const order = await O.createOrder({ address: addr, pack: 5 });
  TX[txid("d")] = { vout: [{ scriptpubkey_address: "bc1qattacker000000000", value: order.sats }], status: { confirmed: true, block_height: 900100 } };
  O.attachTx(addr, order.id, txid("d"));
  await O.sweepOrders(addr);
  assert.equal(O.getBalance(addr), 0);
});

test("the same txid cannot be reused for a second order", async () => {
  const addr = ADDR + "5";
  const o2 = await O.createOrder({ address: addr, pack: 5 });
  assert.throws(() => O.attachTx(addr, o2.id, txid("a")), /already used/);
});

test("a created-but-never-paid order is NOT saved (cancelled purchase leaves nothing)", async () => {
  const addr = ADDR + "6";
  const before = O.listOrders(addr).length;
  await O.createOrder({ address: addr, pack: 100 });   // user opens the wallet…
  await O.createOrder({ address: addr, pack: 10 });    // …changes their mind, tries again…
  await O.sweepOrders(addr);
  assert.equal(O.listOrders(addr).length, before, "unpaid quotes must never reach the history");
  assert.equal(O.getBalance(addr), 0);
});

test("the order appears in history only once the payment is broadcast", async () => {
  const addr = ADDR + "7";
  const order = await O.createOrder({ address: addr, pack: 5 });
  assert.equal(O.listOrders(addr).length, 0, "not saved yet");
  TX[txid("e")] = { vout: [{ scriptpubkey_address: PAY_TO, value: order.sats }], status: { confirmed: false } };
  O.attachTx(addr, order.id, txid("e"));
  const saved = O.listOrders(addr);
  assert.equal(saved.length, 1, "saved on payment");
  assert.equal(saved[0].status, "pending");
});

test("spending decrements, and never goes below zero", () => {
  const addr = ADDR;                       // has 5 from the confirmed order
  assert.equal(O.spendQuestion(addr), true);
  assert.equal(O.getBalance(addr), 4);
  O.addQuestions(addr, -4);                // drain
  assert.equal(O.spendQuestion(addr), false, "no balance -> cannot spend");
  assert.equal(O.getBalance(addr), 0);
});

test("balances and orders survive a restart (persisted to disk)", async () => {
  const fresh = await import(`../src/orders.js?restart=${Date.now()}`);
  assert.equal(fresh.getBalance(ADDR + "2"), 0);
  assert.ok(fresh.listOrders(ADDR).length >= 1, "order history persisted");
});

// --- promo redemption limits -------------------------------------------------
test("by default a code works ONCE per wallet — and still works for everyone else", async () => {
  const a = ADDR + "p1", b = ADDR + "p2";
  assert.equal((await O.quote(10, "be the bitmap", { address: a })).promoApplied, true);

  await payFor(a, 10, "be the bitmap", txid("1"));
  const again = await O.quote(10, "be the bitmap", { address: a });
  assert.equal(again.promoApplied, false, "second use by the same wallet gets no discount");
  assert.equal(again.promoUsed, true);
  assert.equal(again.eur, 10, "full price");

  const other = await O.quote(10, "be the bitmap", { address: b });
  assert.equal(other.promoApplied, true, "a different wallet is unaffected");
});

test("the admin can allow a code more times per wallet — or unlimited (0)", async () => {
  const a = ADDR + "p3";
  A.createPromo({ code: "twice club", discountPct: 25, days: 0, perAddress: 2, maxTotal: 0 });
  await payFor(a, 5, "twice club", txid("2"));
  assert.equal((await O.quote(5, "twice club", { address: a })).promoApplied, true, "second use allowed");
  await payFor(a, 5, "twice club", txid("3"));
  assert.equal((await O.quote(5, "twice club", { address: a })).promoUsed, true, "third use blocked");

  A.setPromoLimits("twice club", { perAddress: 0 });   // 0 = infinite
  const unlimited = await O.quote(5, "twice club", { address: a });
  assert.equal(unlimited.promoApplied, true);
  assert.equal(unlimited.discountPct, 25);
});

test("a total cap retires the code for everybody once it is reached", async () => {
  const a = ADDR + "p4", b = ADDR + "p5";
  A.createPromo({ code: "first only", discountPct: 100, days: 0, perAddress: 1, maxTotal: 1 });
  await payFor(a, 5, "first only", txid("4"));
  const late = await O.quote(5, "first only", { address: b });
  assert.equal(late.promoApplied, false);
  assert.equal(late.promoExhausted, true, "not 'you already used it' — nobody can use it now");
});

test("a checkout in flight holds the code, cancelling releases it", async () => {
  const a = ADDR + "p6";
  A.createPromo({ code: "hold me", discountPct: 50, days: 0, perAddress: 1, maxTotal: 0 });
  const draft = await O.createOrder({ address: a, pack: 5, promo: "hold me" });
  assert.equal(draft.promoApplied, true);
  assert.equal((await O.quote(5, "hold me", { address: a })).promoUsed, true, "a second tab cannot double-spend it");

  O.cancelOrder(a, draft.id);
  assert.equal((await O.quote(5, "hold me", { address: a })).promoApplied, true, "cancelled checkout gives the use back");
});

test("an underpaid order does not burn the code", async () => {
  const a = ADDR + "p7";
  A.createPromo({ code: "half paid", discountPct: 50, days: 0, perAddress: 1, maxTotal: 0 });
  const order = await O.createOrder({ address: a, pack: 10, promo: "half paid" });
  TX[txid("5")] = { vout: [{ scriptpubkey_address: PAY_TO, value: Math.floor(order.sats / 2) }], status: { confirmed: true, block_height: 900100 } };
  O.attachTx(a, order.id, txid("5"));
  await O.sweepOrders(a);
  assert.equal(O.listOrders(a)[0].status, "underpaid");
  assert.equal((await O.quote(10, "half paid", { address: a })).promoApplied, true, "they got nothing, so they keep the use");
});

test("admin sees how many times each code was redeemed", async () => {
  const counts = O.promoUseCounts();
  assert.equal(counts["be the bitmap"], 1);
  assert.equal(counts["twice club"], 2);
  assert.equal(counts["first only"], 1);
  assert.ok(!counts["half paid"], "underpaid orders are not counted as redemptions");
});

test.after(() => { for (const f of [file, adminFile]) { try { fs.unlinkSync(f); } catch {} } });
