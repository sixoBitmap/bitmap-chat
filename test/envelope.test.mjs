// Byte-level check of the ord envelope the browser is about to pay for.
//
// The browser loads @scure/btc-signer and micro-ordinals from esm.sh; here we
// load the SAME pinned versions from node_modules and run the real encoder.
// Every id-encoding bug — reversed txid, trimmed little-endian index, i0 vs
// i256 — dies in this file rather than on mainnet.
import test from "node:test";
import assert from "node:assert";
import * as btc from "@scure/btc-signer";
import * as ordl from "micro-ordinals";
import { schnorr } from "@noble/curves/secp256k1";
import { buildEnvelope, verifyEnvelope } from "../web/inscribe-tx.js";
import { planInscription } from "../web/inscribe-plan.js";

const ME = "bc1pmine0000000000000000000000000000000000000000000000000000";
const hex = (c) => c.repeat(64);
const insc = (c, n = 0) => `${hex(c)}i${n}`;
const anchor = (over = {}) => ({ id: insc("a"), txid: hex("a"), vout: 0, offset: 0, value: 546, address: ME, ...over });
const enc = new TextEncoder();

// encode a plan the way the browser does, then read the script back
function roundTrip(plan, body = enc.encode("hello")) {
  const envelope = buildEnvelope(plan, plan.tags.contentType ? body : new Uint8Array(0));
  const pub = schnorr.getPublicKey(new Uint8Array(32).fill(7));
  const { script } = ordl.p2tr_ord_reveal(pub, [envelope]);
  return verifyEnvelope(btc, ordl, script, plan); // throws on any mismatch
}

const mk = (o) => planInscription({
  anchor: anchor(), ordAddress: ME, contentType: "text/plain;charset=utf-8", bodyBytes: 5, ...o,
});

test("reinscription: content type and pointer survive encoding", () => {
  const p = mk({ relation: "reinscription", payload: "text" });
  const got = roundTrip(p);
  assert.equal(got.tags.contentType, "text/plain;charset=utf-8");
  assert.equal(Number(got.tags.pointer ?? 0), 0);
});

test("child: the parent id round-trips exactly (reversed txid + index encoding)", () => {
  const p = mk({ relation: "child", payload: "text", anchor: anchor({ value: 1200 }) });
  const got = roundTrip(p);
  assert.equal(got.tags.parent, insc("a"), "parent id must come back byte-identical");
  assert.equal(Number(got.tags.pointer), 1200);
});

test("every inscription-index form survives: i0, i1, i255, i256, i65536", () => {
  for (const n of [0, 1, 255, 256, 65536]) {
    const parent = { id: insc("b", n), txid: hex("b"), vout: 0, offset: 0, value: 546, address: ME };
    const p = mk({ relation: "child", payload: "text", extraParents: [parent] });
    const got = roundTrip(p);
    const parents = Array.isArray(got.tags.parent) ? got.tags.parent : [got.tags.parent];
    assert.ok(parents.includes(insc("b", n)), `i${n} must survive the trimmed little-endian index encoding`);
  }
});

test("multiple parents keep their order and count", () => {
  const ps = ["b", "c", "d"].map((c) => ({ id: insc(c), txid: hex(c), vout: 0, offset: 0, value: 546, address: ME }));
  const p = mk({ relation: "child", payload: "text", extraParents: ps });
  const got = roundTrip(p);
  assert.deepEqual(got.tags.parent, [insc("a"), insc("b"), insc("c"), insc("d")]);
});

test("delegate encodes with no content type and an empty body", () => {
  const p = mk({ relation: "reinscription", payload: "delegate", delegate: insc("e", 3), contentType: undefined, bodyBytes: 0 });
  const got = roundTrip(p);
  assert.equal(got.tags.delegate, insc("e", 3));
  assert.ok(!got.tags.contentType, "a delegate carries no content type");
});

test("delegate + parent together", () => {
  const p = mk({ relation: "child", payload: "delegate", delegate: insc("e"), contentType: undefined, bodyBytes: 0 });
  const got = roundTrip(p);
  assert.equal(got.tags.delegate, insc("e"));
  assert.equal(got.tags.parent, insc("a"));
});

test("pointer 0 is encoded explicitly, not dropped", () => {
  // ord treats a missing pointer as "first sat of the input carrying the
  // envelope" — for a reinscription that is the wrong sat entirely.
  const p = mk({ relation: "reinscription", payload: "text" });
  assert.equal(p.pointer, 0);
  const got = roundTrip(p);
  assert.equal(Number(got.tags.pointer ?? -1), 0, "pointer 0 must be present in the envelope");
});

test("verifyEnvelope actually catches a tampered plan", () => {
  const p = mk({ relation: "child", payload: "text" });
  const envelope = buildEnvelope(p, enc.encode("hello"));
  const pub = schnorr.getPublicKey(new Uint8Array(32).fill(9));
  const { script } = ordl.p2tr_ord_reveal(pub, [envelope]);
  // the script says pointer 546; claim we meant something else
  assert.throws(() => verifyEnvelope(btc, ordl, script, { ...p, tags: { ...p.tags, pointer: 99 } }), /pointer mismatch/);
  assert.throws(() => verifyEnvelope(btc, ordl, script, { ...p, tags: { ...p.tags, parent: [insc("a"), insc("z")] } }), /parents did not survive/);
});

test("metadata (tag 5) round-trips through CBOR — as an object and as text", () => {
  const obj = mk({ relation: "child", payload: "text", metadata: { artist: "peran", edition: 3, ok: true } });
  const gotObj = roundTrip(obj);
  assert.deepEqual(gotObj.tags.metadata, { artist: "peran", edition: 3, ok: true });
  assert.equal(gotObj.tags.parent, insc("a"), "metadata does not disturb the other tags");

  const txt = mk({ relation: "reinscription", payload: "text", metadata: "just a note" });
  assert.equal(roundTrip(txt).tags.metadata, "just a note");
});

test("no metadata means no tag 5 at all", () => {
  const p = mk({ relation: "reinscription", payload: "text" });
  assert.equal(p.tags.metadata, undefined);
  assert.equal(roundTrip(p).tags.metadata, undefined);
});

test("verifyEnvelope catches metadata that changed under it", () => {
  const p = mk({ relation: "reinscription", payload: "text", metadata: { a: 1 } });
  const envelope = buildEnvelope(p, enc.encode("hi"));
  const pub = schnorr.getPublicKey(new Uint8Array(32).fill(13));
  const { script } = ordl.p2tr_ord_reveal(pub, [envelope]);
  assert.throws(() => verifyEnvelope(btc, ordl, script, { ...p, tags: { ...p.tags, metadata: { a: 2 } } }), /metadata did not survive/);
});

test("a real body round-trips unchanged", () => {
  const body = enc.encode('{"hello":"bitmap"}');
  const p = mk({ relation: "reinscription", payload: "text", contentType: "application/json", bodyBytes: body.length });
  const envelope = buildEnvelope(p, body);
  const pub = schnorr.getPublicKey(new Uint8Array(32).fill(11));
  const got = ordl.parseInscriptions(btc.Script.decode(ordl.p2tr_ord_reveal(pub, [envelope]).script), true)[0];
  assert.equal(new TextDecoder().decode(got.body), '{"hello":"bitmap"}');
  assert.equal(got.tags.contentType, "application/json");
});
