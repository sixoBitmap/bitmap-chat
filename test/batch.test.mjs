// Minting many parcels in one reveal. Same money rules as a single child, but
// N pointers instead of one — and a pointer that misses its output hands that
// inscription to the miner, so every one of them is pinned down here.
import test from "node:test";
import assert from "node:assert";
import * as btc from "@scure/btc-signer";
import * as ordl from "micro-ordinals";
import { schnorr } from "@noble/curves/secp256k1";
import { planBatch, DUST } from "../web/inscribe-plan.js";
import { verifyBatch } from "../web/inscribe-tx.js";

const ME = "bc1pmine0000000000000000000000000000000000000000000000000000";
const THEM = "bc1ptheirs00000000000000000000000000000000000000000000000000";
const hex = (c) => c.repeat(64);
const parent = (over = {}) => ({ id: `${hex("a")}i0`, txid: hex("a"), vout: 0, offset: 0, value: 546, address: ME, ...over });
const parcels = (nums) => nums.map((n) => ({ text: `${n}.114588.bitmap` }));
const plan = (o) => planBatch({ anchor: parent(), ordAddress: ME, items: parcels([1, 2, 3]), ...o });

test("one parent input, one output each, parent returned whole", () => {
  const p = plan({ anchor: parent({ value: 1200 }) });
  assert.equal(p.ins.length, 1, "a single parent input covers every child");
  assert.deepEqual(p.outs.map((o) => o.value), [1200, DUST, DUST, DUST]);
  assert.equal(p.count, 3);
  assert.equal(p.outs[0].value, 1200, "the parent comes back at its full value");
});

test("each pointer lands exactly on its own output", () => {
  const p = plan({ anchor: parent({ value: 900 }), postage: 546 });
  assert.deepEqual(p.envelopes.map((e) => e.tags.pointer), [900, 1446, 1992]);
  p.envelopes.forEach((e, i) => {
    const before = p.outs.slice(0, i + 1).reduce((s, o) => s + o.value, 0);
    assert.equal(e.tags.pointer, before, `pointer ${i}`);
    assert.ok(e.tags.pointer < p.outTotal, "and stays inside the outputs");
  });
});

test("every envelope carries the parent tag and its own text", () => {
  const p = plan({ items: parcels([7, 8]) });
  assert.equal(p.envelopes.length, 2);
  for (const e of p.envelopes) assert.equal(e.tags.parent, `${hex("a")}i0`);
  assert.deepEqual(p.envelopes.map((e) => e.text), ["7.114588.bitmap", "8.114588.bitmap"]);
  assert.equal(p.envelopes[0].tags.contentType, "text/plain;charset=utf-8");
});

test("the commit funds every new postage, and the balance holds", () => {
  const p = plan({ items: parcels([1, 2, 3, 4, 5]), postage: 1000 });
  assert.equal(p.commitValue(3000), 3000 + 1000 * 5);
  assert.equal(p.outTotal - p.inTotal, 1000 * 5, "only the new sats come from the commit");
});

test("a big batch keeps every invariant", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ text: `${i}.114588.bitmap` }));
  const p = plan({ items: many });
  assert.equal(p.count, 40);
  assert.equal(p.outs.length, 41);
  const seen = new Set();
  p.envelopes.forEach((e, i) => {
    const before = p.outs.slice(0, i + 1).reduce((s, o) => s + o.value, 0);
    assert.equal(e.tags.pointer, before);
    assert.ok(!seen.has(e.tags.pointer), "no two inscriptions share a pointer");
    seen.add(e.tags.pointer);
  });
});

test("only the parent's holder can mint its children", () => {
  assert.throws(() => plan({ anchor: parent({ address: THEM }) }), /only its holder/);
});

test("bad input is refused before any wallet opens", () => {
  assert.throws(() => plan({ items: [] }), /nothing selected/);
  assert.throws(() => plan({ items: [{ text: "" }] }), /item 1 is empty/);
  assert.throws(() => plan({ postage: 10 }), /postage must be at least/);
  assert.throws(() => plan({ ordAddress: "" }), /connect your wallet/);
  assert.throws(() => plan({ anchor: parent({ value: 100 }) }), /too small to spend safely/);
  const tooMany = Array.from({ length: 41 }, (_, i) => ({ text: `${i}.x` }));
  assert.throws(() => plan({ items: tooMany }), /too many at once/);
});

test("all the envelopes survive real encoding, in order, each with its pointer", () => {
  const p = plan({ items: parcels([20, 21, 22, 23, 24]) });
  const enc = new TextEncoder();
  const envelopes = p.envelopes.map((e) => ({
    tags: { contentType: e.tags.contentType, parent: e.tags.parent, pointer: BigInt(e.tags.pointer) },
    body: enc.encode(e.text),
  }));
  const pub = schnorr.getPublicKey(new Uint8Array(32).fill(5));
  const { script } = ordl.p2tr_ord_reveal(pub, envelopes);
  const got = verifyBatch(btc, ordl, script, p);   // throws on any mismatch
  assert.equal(got.length, 5, "one tapscript, five inscriptions");
  assert.deepEqual(got.map((g) => new TextDecoder().decode(g.body)),
    ["20.114588.bitmap", "21.114588.bitmap", "22.114588.bitmap", "23.114588.bitmap", "24.114588.bitmap"]);
  assert.deepEqual(got.map((g) => Number(g.tags.pointer)), p.envelopes.map((e) => e.tags.pointer));
});

test("verifyBatch catches a plan that drifted from the script", () => {
  const p = plan({ items: parcels([1, 2]) });
  const enc = new TextEncoder();
  const envelopes = p.envelopes.map((e) => ({
    tags: { contentType: e.tags.contentType, parent: e.tags.parent, pointer: BigInt(e.tags.pointer) },
    body: enc.encode(e.text),
  }));
  const pub = schnorr.getPublicKey(new Uint8Array(32).fill(6));
  const { script } = ordl.p2tr_ord_reveal(pub, envelopes);
  const tampered = { ...p, envelopes: [{ ...p.envelopes[0], text: "99.114588.bitmap" }, p.envelopes[1]] };
  assert.throws(() => verifyBatch(btc, ordl, script, tampered), /content did not survive/);
  const short = { ...p, envelopes: [p.envelopes[0]] };
  assert.throws(() => verifyBatch(btc, ordl, script, short), /not the 1 intended/);
});

test("a batch of one behaves like a single child", () => {
  const p = plan({ items: parcels([42]), anchor: parent({ value: 546 }) });
  assert.deepEqual(p.outs.map((o) => o.value), [546, DUST]);
  assert.equal(p.envelopes[0].tags.pointer, 546);
});
