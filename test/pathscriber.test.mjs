// Claiming a PathScriber by inscription id. The rule that matters: a claim is
// only a pointer — content AND current ownership decide, every time.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const claimsFile = path.join(os.tmpdir(), `bac-claims-test-${process.pid}.json`);
process.env.CLAIMS_FILE = claimsFile;

const SOURCE = "914e2538118b4cffcf1eced6187462eb1ebcfcc95146c027edba78efee00310bi0";
const MINT = `/content/${SOURCE}`;
const MINE = "bc1qholder00000000000000000000000000000000";
const THEIRS = "bc1qsomeoneelse0000000000000000000000000000";
const hex = (c) => c.repeat(64);

// a tiny fake ord: id -> { content, address }
const CHAIN = {
  [`${hex("a")}i0`]: { content: MINT, address: MINE },      // my PathScriber
  [`${hex("b")}i0`]: { content: MINT, address: THEIRS },    // someone else's
  [`${hex("c")}i0`]: { content: "114588.bitmap", address: MINE }, // not a mint
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  let m = u.match(/\/r\/inscription\/([a-f0-9]{64}i\d+)$/);
  if (m) {
    const e = CHAIN[m[1]];
    return e
      ? new Response(JSON.stringify({ id: m[1], address: e.address, content_length: e.content.length, number: 71771219 }), { status: 200 })
      : new Response("not found", { status: 404 });
  }
  m = u.match(/\/content\/([a-f0-9]{64}i\d+)$/);
  if (m) {
    const e = CHAIN[m[1]];
    return e ? new Response(e.content, { status: 200 }) : new Response("not found", { status: 404 });
  }
  return realFetch(url);
};

const W = await import("../src/wallet.js");
const C = await import("../src/claims.js");

test("a PathScriber the wallet holds is accepted", async () => {
  const v = await W.verifyScriber(`${hex("a")}i0`, MINE);
  assert.equal(v.ok, true);
  assert.equal(v.owner, MINE);
});

test("someone else's PathScriber is refused — pasting a known id grants nothing", async () => {
  const v = await W.verifyScriber(`${hex("b")}i0`, MINE);
  assert.equal(v.ok, false);
  assert.match(v.reason, /not in this wallet/);
});

test("an inscription that isn't a mint is refused", async () => {
  const v = await W.verifyScriber(`${hex("c")}i0`, MINE);
  assert.equal(v.ok, false);
  assert.match(v.reason, /not a PathScriber/);
});

test("an unknown inscription says 'not indexed yet' rather than failing blankly", async () => {
  const v = await W.verifyScriber(`${hex("d")}i0`, MINE);
  assert.equal(v.ok, false);
  assert.match(v.reason, /doesn't know that inscription yet|few minutes/);
});

test("garbage input is rejected before any network call", async () => {
  for (const bad of ["", "hello", hex("a"), `${hex("a")}i`, null]) {
    const v = await W.verifyScriber(bad, MINE);
    assert.equal(v.ok, false, `rejected: ${JSON.stringify(bad)}`);
    assert.match(v.reason, /not an inscription id/);
  }
});

test("claims persist, and one id belongs to one address (a sale moves it)", () => {
  C.addClaim(MINE, `${hex("a")}i0`);
  assert.deepEqual(C.claimedBy(MINE), [`${hex("a")}i0`]);
  C.addClaim(THEIRS, `${hex("a")}i0`);            // sold, new owner claims it
  assert.deepEqual(C.claimedBy(MINE), [], "the old owner's claim is gone");
  assert.deepEqual(C.claimedBy(THEIRS), [`${hex("a")}i0`]);
  assert.equal(C.claimIndex()[`${hex("a")}i0`].address, THEIRS);
});

test("a claim on a PathScriber that was sold stops verifying", async () => {
  C.addClaim(MINE, `${hex("a")}i0`);
  assert.equal((await W.verifyScriber(`${hex("a")}i0`, MINE)).ok, true);
  CHAIN[`${hex("a")}i0`].address = THEIRS;        // sold
  const after = await W.verifyScriber(`${hex("a")}i0`, MINE);
  assert.equal(after.ok, false, "the stored claim can no longer grant access");
  CHAIN[`${hex("a")}i0`].address = MINE;
});

test("the admin can drop a claim", () => {
  C.addClaim(MINE, `${hex("a")}i0`);
  assert.equal(C.removeClaim(`${hex("a")}i0`), true);
  assert.deepEqual(C.claimedBy(MINE), []);
  assert.equal(C.removeClaim(`${hex("a")}i0`), false, "dropping it twice is a no-op");
});

test.after(() => { try { fs.unlinkSync(claimsFile); } catch {} });
