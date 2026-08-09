// Buying a listed parcel. The seller's signature covers the output at the same
// index as their input, so index drift is the failure that loses real money.
// Every test here exists because of that one rule.
import test from "node:test";
import assert from "node:assert";
import { planPurchase, planDummies, SELLER_INDEX, DUST } from "../web/market-plan.js";

const BUYER_ORD = "bc1pbuyerord0000000000000000000000000000000000000000000000";
const BUYER_PAY = "bc1qbuyerpay000000000000000000000000000000";
const SELLER_PAY = "bc1qsellerpay00000000000000000000000000000";
const hex = (c) => c.repeat(64);

const listing = (over = {}) => ({
  utxo: { txid: hex("a"), vout: 0, value: 546 },
  priceSats: 50_000, sellerScriptAddress: SELLER_PAY, ...over,
});
const dummies = () => [
  { txid: hex("b"), vout: 0, value: 600 },
  { txid: hex("c"), vout: 1, value: 600 },
];
const funding = (n = 200_000) => [{ txid: hex("d"), vout: 0, value: n }];
const buy = (over = {}) => planPurchase({
  listing: listing(), buyer: { ordAddress: BUYER_ORD, payAddress: BUYER_PAY },
  dummies: dummies(), funding: funding(), feeRate: 6, ...over,
});

test("THE rule: the seller's payment sits at the same index as their input", () => {
  const p = buy();
  assert.equal(p.sellerInputIndex, SELLER_INDEX);
  assert.equal(p.ins[p.sellerInputIndex].owner, "seller");
  assert.equal(p.outs[p.sellerInputIndex].role, "payment");
  assert.equal(p.outs[p.sellerInputIndex].value, 50_000);
  assert.equal(p.outs[p.sellerInputIndex].to, SELLER_PAY);
});

test("the fixed shape: padding, parcel, payment, change", () => {
  const p = buy();
  assert.deepEqual(p.ins.map((i) => i.role), ["padding", "padding", "parcel", "funding"]);
  assert.deepEqual(p.outs.map((o) => o.role), ["padding", "parcel", "payment", "change"]);
  assert.equal(p.outs[0].value, 1200, "the two padding coins are recombined");
  assert.equal(p.outs[1].value, 546, "the parcel keeps its own sats");
  assert.equal(p.outs[1].to, BUYER_ORD, "and goes to the buyer's ordinals address");
});

test("the buyer signs their own inputs and never the seller's", () => {
  const p = buy();
  assert.deepEqual(p.buyerInputIndexes, [0, 1, 3]);
  assert.ok(!p.buyerInputIndexes.includes(SELLER_INDEX), "signing the seller's input would be a forgery attempt");
});

test("it balances: inputs = outputs + fee", () => {
  const p = buy();
  const inTotal = p.ins.reduce((s, i) => s + i.value, 0);
  const outTotal = p.outs.reduce((s, o) => s + o.value, 0);
  assert.equal(inTotal - outTotal, p.fee);
  // the parcel's 546 sats come from the seller's input, not the buyer's pocket
  assert.equal(p.total, 50_000 + p.fee, "what the buyer is really spending");
});

test("more funding inputs keep the seller's index fixed at 2", () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ txid: hex(String(i)), vout: 0, value: 20_000 }));
  const p = buy({ funding: many });
  assert.equal(p.sellerInputIndex, SELLER_INDEX, "extra funding is appended, never inserted before the parcel");
  assert.equal(p.outs[SELLER_INDEX].role, "payment");
  assert.ok(p.ins.length > 4);
});

test("a change output too small to matter is dropped, not created as dust", () => {
  // fund it so tightly that the leftover is below the dust floor
  const p = planPurchase({
    listing: listing(), buyer: { ordAddress: BUYER_ORD, payAddress: BUYER_PAY },
    dummies: dummies(), feeRate: 1,
    funding: [{ txid: hex("e"), vout: 0, value: 50_546 + 400 }],
  });
  assert.ok(!p.outs.some((o) => o.role === "change" && o.value < DUST));
  assert.equal(p.outs[SELLER_INDEX].role, "payment", "and the indexes still line up");
});

test("padding has to be padding — not dust, not an inscription-sized coin", () => {
  assert.throws(() => buy({ dummies: [{ txid: hex("b"), vout: 0, value: 300 }, dummies()[1]] }), /must hold between/);
  assert.throws(() => buy({ dummies: [{ txid: hex("b"), vout: 0, value: 9000 }, dummies()[1]] }), /must hold between/);
  assert.throws(() => buy({ dummies: [dummies()[0]] }), /two small padding outputs/);
});

test("the same coin cannot be used twice", () => {
  const d = dummies();
  assert.throws(() => buy({ dummies: [d[0], d[0]] }), /cannot be spent twice/);
  assert.throws(() => buy({ funding: [{ txid: hex("b"), vout: 0, value: 90_000 }] }), /cannot be spent twice/);
});

test("too little bitcoin is refused with the real number", () => {
  assert.throws(() => buy({ funding: [{ txid: hex("f"), vout: 0, value: 1000 }] }), /not enough confirmed bitcoin/);
});

test("nonsense listings are refused before a wallet opens", () => {
  assert.throws(() => buy({ listing: listing({ priceSats: 10 }) }), /no sensible price/);
  assert.throws(() => buy({ listing: listing({ sellerScriptAddress: "" }) }), /no payout address/);
  assert.throws(() => buy({ buyer: { ordAddress: "", payAddress: "" } }), /connect your wallet/);
  assert.throws(() => buy({ listing: { priceSats: 5000 } }), /no parcel attached/);
});

test("preparing padding: two small outputs and change", () => {
  const p = planDummies({ payAddress: BUYER_PAY, funding: funding(), feeRate: 6 });
  assert.deepEqual(p.outs.slice(0, 2).map((o) => o.value), [600, 600]);
  assert.equal(p.outs[0].to, BUYER_PAY);
  const inTotal = p.ins.reduce((s, i) => s + i.value, 0);
  assert.equal(inTotal - p.outs.reduce((s, o) => s + o.value, 0), p.fee);
  assert.throws(() => planDummies({ payAddress: BUYER_PAY, funding: [{ txid: hex("1"), vout: 0, value: 500 }] }), /not enough/);
});
