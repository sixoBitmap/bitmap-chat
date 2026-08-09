// The marketplace holds no coins and no keys — only signed offers. What it
// must get right is refusing to advertise something that isn't for sale:
// not a real parcel, not the seller's, or already moved on-chain.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const file = path.join(os.tmpdir(), `bac-market-test-${process.pid}.json`);
process.env.MARKET_FILE = file;
process.env.ADMIN_FILE = path.join(os.tmpdir(), `bac-market-admin-${process.pid}.json`);

const ME = "bc1pseller00000000000000000000000000000000000000000000000000";
const THEM = "bc1pbuyer000000000000000000000000000000000000000000000000000";
const hex = (c) => c.repeat(64);
const PARCEL = `${hex("a")}i0`;      // a canonical parcel of the gate
const NOT_PARCEL = `${hex("b")}i0`;  // an inscription that is not one

// the chain, as far as these tests are concerned
let owner = { [PARCEL]: ME, [NOT_PARCEL]: ME };
let satpoint = { [PARCEL]: `${hex("a")}:0:0`, [NOT_PARCEL]: `${hex("b")}:0:0` };

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const m = u.match(/\/r\/inscription\/([a-f0-9]{64}i\d+)/);
  if (m) {
    return new Response(JSON.stringify({ id: m[1], address: owner[m[1]] ?? null, satpoint: satpoint[m[1]], value: 546 }), { status: 200 });
  }
  return realFetch(url, opts);
};

// the parcel authority, injected so the test doesn't have to crawl the chain
const gate = async () => ({
  parcelById: new Map([[PARCEL, { x: 7, text: "7.114588.bitmap", number: 12345 }]]),
  txCount: 100,
});

const M = await import("../src/market.js");
const psbt = "cHNidP8" + "A".repeat(120);
const list = (over = {}) => M.listParcel({ seller: ME, inscriptionId: PARCEL, priceSats: 50000, psbt, ...over }, { gate });

test("a parcel the seller holds can be listed", async () => {
  const l = await list();
  assert.equal(l.parcel, "7.114588.bitmap");
  assert.equal(l.priceSats, 50000);
  assert.equal(l.status, "live");
  assert.ok(!("psbt" in l), "the signed offer is never handed out with the browse list");
});

test("browsing shows it, still without the offer", async () => {
  const rows = await M.liveListings();
  assert.equal(rows.length, 1);
  assert.ok(!("psbt" in rows[0]));
  assert.equal(M.marketStats().live, 1);
  assert.equal(M.marketStats().floor, 50000);
});

test("the signed offer comes only when someone asks to buy", () => {
  const id = M.allListings()[0].id;
  assert.equal(M.offerFor(id).psbt, psbt);
});

test("an inscription that is not a canonical parcel is refused", async () => {
  await assert.rejects(() => list({ inscriptionId: NOT_PARCEL }), /not a canonical/);
});

test("you cannot list what you do not hold", async () => {
  await assert.rejects(() => list({ seller: THEM }), /don't hold that parcel/);
});

test("silly prices and malformed offers are refused", async () => {
  await assert.rejects(() => list({ priceSats: 10 }), /at least/);
  await assert.rejects(() => list({ priceSats: 1e15 }), /not plausible/);
  await assert.rejects(() => list({ psbt: "no" }), /not a signed transaction/);
  await assert.rejects(() => list({ inscriptionId: "rubbish" }), /not an inscription id/);
});

test("relisting replaces rather than duplicating", async () => {
  await list({ priceSats: 70000 });
  const rows = await M.liveListings();
  assert.equal(rows.length, 1, "one parcel, one listing");
  assert.equal(rows[0].priceSats, 70000);
});

test("a parcel that leaves the seller stops being for sale", async () => {
  const before = (await M.liveListings())[0];
  assert.equal(before.status, "live");
  owner[PARCEL] = THEM;                       // sold elsewhere, or just moved
  M.allListings();                            // (no re-check yet)
  const rows = await M.liveListings();        // the freshness window is bypassed below
  const l = rows[0];
  // force the re-check by ageing the record
  if (l.status === "live") {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.listings[0].checkedAt = 0;
    fs.writeFileSync(file, JSON.stringify(raw));
    const fresh = await import(`../src/market.js?reload=${Date.now()}`);
    const after = await fresh.liveListings();
    assert.equal(after[0].status, "gone", "a moved parcel is never advertised as live");
  } else {
    assert.equal(l.status, "gone");
  }
  owner[PARCEL] = ME;
});

test("only the seller (or an admin) can withdraw a listing", async () => {
  const id = M.allListings()[0].id;
  assert.throws(() => M.delist(id, THEM), /not your listing/);
  assert.equal(M.delist(id, THEM, { isAdmin: true }), true);
  assert.equal(M.allListings().length, 0);
});

test("a sale records the transaction and closes the offer", async () => {
  const l = await list();
  const sold = M.markSold(l.id, hex("f"));
  assert.equal(sold.status, "sold");
  assert.equal(sold.txid, hex("f"));
  assert.throws(() => M.offerFor(l.id), /no longer for sale/);
  assert.equal(M.marketStats().sold, 1);
  assert.throws(() => M.markSold(l.id, "nope"), /not a transaction id/);
});

test.after(() => {
  for (const f of [file, process.env.ADMIN_FILE]) { try { fs.unlinkSync(f); } catch {} }
});
