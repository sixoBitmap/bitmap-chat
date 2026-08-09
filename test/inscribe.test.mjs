// The inscription planner decides where real satoshis go. Every rule here
// maps to a way of losing money on mainnet, so they are all pinned down.
import test from "node:test";
import assert from "node:assert";
import { planInscription, DUST } from "../web/inscribe-plan.js";

const ME = "bc1pmine0000000000000000000000000000000000000000000000000000";
const THEM = "bc1ptheirs00000000000000000000000000000000000000000000000000";
const hex = (c) => c.repeat(64);
const insc = (c, n = 0) => `${hex(c)}i${n}`;

const anchor = (over = {}) => ({
  id: insc("a"), txid: hex("a"), vout: 0, offset: 0, value: 546, address: ME, ...over,
});
const parent = (c, over = {}) => ({
  id: insc(c), txid: hex(c), vout: 0, offset: 0, value: 546, address: ME, ...over,
});
const base = { anchor: anchor(), ordAddress: ME, contentType: "text/plain;charset=utf-8", bodyBytes: 12 };

const plan = (o) => planInscription({ ...base, ...o });
const fails = (o, re) => assert.throws(() => plan(o), re);

// --- the four shapes ---------------------------------------------------------
test("reinscription: one output, pointer at the sat, postage covers the whole input", () => {
  const p = plan({ relation: "reinscription", payload: "text" });
  assert.equal(p.ins.length, 1);
  assert.deepEqual(p.outs.map((o) => o.value), [546]);
  assert.equal(p.pointer, 0);
  assert.equal(p.tags.contentType, "text/plain;charset=utf-8");
  assert.ok(!p.tags.parent, "a reinscription has no parent tag");
});

test("reinscription: left alone, the whole input comes back — nothing bundled is burned", () => {
  const p = plan({ relation: "reinscription", payload: "text", anchor: anchor({ value: 10_000 }), postage: undefined });
  assert.equal(p.postage, 10_000, "the default reproduces the entire output");
  assert.equal(p.outs[0].value, 10_000);
});

test("reinscription: a deliberately smaller postage is honoured, down to the dust floor", () => {
  const p = plan({ relation: "reinscription", payload: "text", anchor: anchor({ value: 10_000 }), postage: 330 });
  assert.equal(p.postage, 330, "the caller's sats, the caller's call");
  assert.equal(p.outTotal, 330);
  const floored = plan({ relation: "reinscription", payload: "text", anchor: anchor({ value: 10_000 }), postage: 10 });
  assert.equal(floored.postage, 330, "but never below the dust floor");
});

test("reinscription: postage can never drop below the sat's own offset", () => {
  // at 330 sats the inscription at offset 900 would fall outside the output and
  // ord would hand it to the miner — the floor moves up to keep it inside
  const p = plan({ relation: "reinscription", payload: "text", anchor: anchor({ value: 10_000, offset: 900 }), postage: 330 });
  assert.equal(p.postage, 901);
  assert.ok(p.pointer < p.outTotal);
});

test("reinscription: a BIGGER postage is honoured and topped up by the commit", () => {
  const bigger = plan({ relation: "reinscription", payload: "text", anchor: anchor({ value: 546 }), postage: 5000 });
  assert.equal(bigger.postage, 5000, "padding the sat with more is allowed");
  assert.equal(bigger.commitValue(2000), 2000 + 5000 - 546, "the extra comes from the commit");
  assert.equal(bigger.burned, 0);
});

test("reinscription: choosing less than the output holds reports what it costs", () => {
  const p = plan({ relation: "reinscription", payload: "text", anchor: anchor({ value: 3000 }), postage: 546 });
  assert.equal(p.postage, 546);
  assert.equal(p.burned, 2454, "the difference goes to the miner and the UI must say so");
  assert.equal(p.commitValue(2000), 360, "nothing needed from the commit beyond the floor");
});

test("reinscription: an inscription sitting past the payout is refused, not silently lost", () => {
  fails({ relation: "reinscription", payload: "text", anchor: anchor({ offset: 900, value: 546 }) }, /cannot reinscribe it safely/);
});

test("child: parent returns whole, child lands after it", () => {
  const p = plan({ relation: "child", payload: "text", anchor: anchor({ value: 1200 }) });
  assert.deepEqual(p.outs.map((o) => o.value), [1200, DUST]);
  assert.equal(p.pointer, 1200, "pointer = everything before the child's output");
  assert.equal(p.tags.parent, insc("a"));
});

test("child with extra parents: one input and one output each, pointer after them all", () => {
  const p = plan({ relation: "child", payload: "text", extraParents: [parent("b"), parent("c", { value: 1000 })] });
  assert.equal(p.ins.length, 3);
  assert.deepEqual(p.outs.map((o) => o.value), [546, 546, 1000, DUST]);
  assert.equal(p.pointer, 546 + 546 + 1000);
  assert.deepEqual(p.tags.parent, [insc("a"), insc("b"), insc("c")]);
});

test("delegate: no content type, no body, still lands on the right sat", () => {
  const p = plan({ relation: "reinscription", payload: "delegate", delegate: insc("d"), contentType: undefined, bodyBytes: 0 });
  assert.equal(p.tags.delegate, insc("d"));
  assert.ok(!p.tags.contentType, "a delegate carries no content type");
  assert.equal(p.pointer, 0);
});

test("delegate works as a child too", () => {
  const p = plan({ relation: "child", payload: "delegate", delegate: insc("d"), contentType: undefined, bodyBytes: 0 });
  assert.equal(p.tags.delegate, insc("d"));
  assert.equal(p.tags.parent, insc("a"));
});

// --- the money-losing cases --------------------------------------------------
test("a parent you do not own is BLOCKED — ord would drop it silently and still charge you", () => {
  fails({ relation: "child", payload: "text", extraParents: [parent("b", { address: THEM })] }, /you don't hold/);
});

test("reinscribing something you no longer hold is blocked", () => {
  fails({ relation: "reinscription", payload: "text", anchor: anchor({ address: THEM }) }, /connect the wallet that holds it/);
});

test("two parents on one UTXO: spent once, returned once, both tags kept", () => {
  const shared = { txid: hex("f"), vout: 0, offset: 0, value: 900, address: ME };
  const p = plan({
    relation: "child", payload: "text",
    extraParents: [{ ...shared, id: insc("f", 0) }, { ...shared, id: insc("f", 1) }],
  });
  assert.equal(p.ins.length, 2, "the shared outpoint is spent once — spending it twice is an invalid tx");
  assert.deepEqual(p.outs.map((o) => o.value), [546, 900, DUST]);
  assert.deepEqual(p.tags.parent, [insc("a"), insc("f", 0), insc("f", 1)], "both parents still attach");
  assert.equal(p.pointer, 546 + 900);
});

test("the same parent twice is rejected", () => {
  fails({ relation: "child", payload: "text", extraParents: [parent("b"), parent("b")] }, /listed twice/);
});

test("a reinscription may ALSO carry parents — the tag and the sat are independent", () => {
  const p = plan({ relation: "reinscription", payload: "text", anchor: anchor({ value: 800 }), extraParents: [parent("b")] });
  assert.equal(p.tags.parent, insc("b"), "the anchor is not a parent here — only the sat it lands on");
  assert.equal(p.ins.length, 2, "the parent's UTXO is spent so the tag is valid");
  assert.deepEqual(p.outs.map((o) => o.value), [800, 546], "anchor back whole, parent back whole");
  assert.equal(p.pointer, 0);
});

test("reinscription at a non-zero offset: the pointer lands inside the returned output", () => {
  const p = plan({ relation: "reinscription", payload: "text", anchor: anchor({ value: 10_000, offset: 4_000 }) });
  assert.equal(p.pointer, 4_000, "the sat sits 4000 into its own UTXO, which comes back whole");
  assert.equal(p.outs[0].value, 10_000);
  assert.ok(p.pointer < p.outTotal);
});

test("reinscription with parents, at an offset, still balances", () => {
  const p = plan({ relation: "reinscription", payload: "text", anchor: anchor({ value: 3000, offset: 1200 }), extraParents: [parent("b"), parent("c", { value: 700 })] });
  assert.equal(p.pointer, 1200);
  assert.deepEqual(p.outs.map((o) => o.value), [3000, 546, 700]);
  assert.equal(p.outTotal, p.inTotal, "nothing extra needed from the commit");
  assert.deepEqual(p.tags.parent, [insc("b"), insc("c")]);
});

test("the anchor cannot be added again as an extra parent", () => {
  fails({ relation: "child", payload: "text", extraParents: [parent("a")] }, /no need to add it again/);
  fails({ relation: "reinscription", payload: "text", extraParents: [parent("a")] }, /no need to add it again/);
});

// --- invariants hold across the whole matrix ---------------------------------
test("for every combination: pointer lands exactly on the new inscription and inside the outputs", () => {
  const cases = [];
  for (const relation of ["reinscription", "child"]) {
    for (const payload of ["text", "file", "delegate"]) {
      for (const value of [546, 1000, 10_000]) {
        for (const offset of [0, 400]) {
          for (const extra of [[], [parent("b")], [parent("b"), parent("c", { value: 2000 })]]) {
            if (offset && relation === "child") continue;   // offset only matters to a reinscription
            cases.push({ relation, payload, anchor: anchor({ value, offset }), extraParents: extra });
          }
        }
      }
    }
  }
  assert.ok(cases.length >= 24, `covering ${cases.length} combinations`);
  for (const c of cases) {
    const p = plan({
      ...c,
      ...(c.payload === "delegate" ? { payload: "delegate", delegate: insc("d"), contentType: undefined, bodyBytes: 0 } : {}),
    });
    const at = p.outs.findIndex((o) => o.role === "inscription");
    const before = p.outs.slice(0, at).reduce((s, o) => s + o.value, 0);
    const want = before + (c.relation === "reinscription" ? c.anchor.offset : 0);
    assert.equal(p.pointer, want, `pointer for ${c.relation}/${c.payload}/offset ${c.anchor.offset}`);
    assert.ok(p.pointer < p.outTotal, "pointer must be inside the outputs or the miner keeps it");
    assert.ok(p.outs.every((o) => o.value >= 330), "no dust outputs");
    assert.ok(p.ins.every((i) => i.value >= 330));
    // the commit only ever tops up what the spent inputs cannot cover
    const fromCommit = p.outTotal - p.inTotal;
    assert.equal(fromCommit, c.relation === "child" ? p.postage : Math.max(0, p.postage - c.anchor.value));
  }
});

test("commitValue covers the reveal fee plus whatever the spent sats cannot", () => {
  const child = plan({ relation: "child", payload: "text" });
  assert.equal(child.commitValue(2000), 2000 + DUST, "child: fee + the new postage");
  const rein = plan({ relation: "reinscription", payload: "text", anchor: anchor({ value: 10_000 }) });
  assert.equal(rein.commitValue(2000), 2000, "reinscription: the sat pays its own postage");
  assert.equal(rein.commitValue(10), 360, "never below the 360-sat floor");
});

// --- input validation --------------------------------------------------------
test("bad input is refused before anything reaches a wallet", () => {
  fails({ relation: "nonsense", payload: "text" }, /pick reinscription or child/);
  fails({ relation: "child", payload: "nope" }, /pick what to inscribe/);
  fails({ relation: "child", payload: "text", ordAddress: "" }, /connect your wallet/);
  fails({ relation: "child", payload: "text", anchor: anchor({ id: "not-an-id" }) }, /no usable inscription id/);
  fails({ relation: "child", payload: "text", anchor: anchor({ value: 300 }) }, /too small to spend safely/);
  fails({ relation: "child", payload: "delegate", delegate: "rubbish" }, /needs an inscription id/);
  fails({ relation: "child", payload: "text", bodyBytes: 0 }, /nothing to inscribe/);
  fails({ relation: "child", payload: "text", bodyBytes: 400_000 }, /too big to inscribe/);
  fails({ relation: "child", payload: "text", contentType: "" }, /choose a content type/);
  fails({ relation: "child", payload: "text", postage: 100 }, /postage must be at least/);
});

test("too many parents is refused (a reveal has to stay standard)", () => {
  const many = ["b", "c", "d", "e", "f", "1", "2"].map((c) => parent(c));
  fails({ relation: "child", payload: "text", extraParents: many }, /too many parents/);
});
