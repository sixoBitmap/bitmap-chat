// A marketplace for gate-bitmap parcels, non-custodial.
//
// Nothing is ever held here. A listing is just a partially-signed transaction
// the seller made: one input (their parcel) and one output (their asking
// price), signed so that anyone may add their own inputs and outputs around it.
// The server stores that signature and the price, and nothing else of value —
// no keys, no coins, no escrow. A buyer completes the transaction in their own
// browser and broadcasts it.
//
// Because the seller keeps custody, a listing can go stale the moment they move
// the parcel. Every read re-checks the chain, so a dead offer is never shown as
// live.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { fetchOrd } from "./oci.js";
import { gateData, GATE_BITMAP } from "./wallet.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.MARKET_FILE || path.join(HERE, "..", ".market.json");

export const MIN_PRICE = Number(process.env.MARKET_MIN_SATS) || 1000;
export const MAX_PRICE = Number(process.env.MARKET_MAX_SATS) || 100_000_000_000;
const FRESH_MS = 60_000; // how long an ownership check is trusted

let db = { listings: [] };
try {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  if (Array.isArray(raw?.listings)) db.listings = raw.listings;
} catch { /* first run */ }

function persist() {
  try { fs.writeFileSync(FILE, JSON.stringify(db, null, 1)); }
  catch (e) { console.error("market: persist failed —", e?.message); }
}

const bad = (message, code = 400) => { throw Object.assign(new Error(message), { code }); };

// Where an inscription lives right now, straight from ord.
async function liveUtxo(id) {
  const m = await fetchOrd(`/r/inscription/${id}`);
  const sp = String(m?.satpoint || "").split(":");
  return { address: m?.address || null, txid: sp[0], vout: Number(sp[1] || 0), value: Number(m?.value) || 0 };
}

/**
 * List a parcel. The seller has already signed the offer in their browser;
 * this only checks that the thing being sold is what it claims to be.
 */
// `gate` is injectable so the rules can be tested without crawling the chain;
// production always uses the real parcel set.
export async function listParcel({ seller, inscriptionId, priceSats, psbt }, { gate: gateSource = gateData } = {}) {
  if (!/^[a-f0-9]{64}i\d+$/i.test(String(inscriptionId || ""))) bad("that is not an inscription id");
  const price = Math.round(Number(priceSats));
  if (!Number.isFinite(price) || price < MIN_PRICE) bad(`the price has to be at least ${MIN_PRICE.toLocaleString("en-US")} sats`);
  if (price > MAX_PRICE) bad("that price is not plausible");
  if (typeof psbt !== "string" || psbt.length < 40 || psbt.length > 100_000) bad("that offer is not a signed transaction");

  // it must be a REAL parcel of the gate bitmap, by the same rule the rest of
  // the app uses — not merely an inscription whose text looks like one
  const gate = await gateSource().catch(() => null);
  if (!gate) bad("could not check the parcel list right now", 502);
  const parcel = gate.parcelById.get(inscriptionId);
  if (!parcel) bad(`that is not a canonical ${GATE_BITMAP} parcel`);

  const utxo = await liveUtxo(inscriptionId).catch(() => null);
  if (!utxo?.address) bad("could not read that inscription on-chain right now", 502);
  if (utxo.address !== seller) bad("you don't hold that parcel");

  db.listings = db.listings.filter((l) => l.inscriptionId !== inscriptionId); // relisting replaces
  const listing = {
    id: "lst_" + crypto.randomBytes(6).toString("hex"),
    inscriptionId, parcel: parcel.text, number: parcel.number ?? null,
    seller, priceSats: price, psbt,
    utxo: { txid: utxo.txid, vout: utxo.vout, value: utxo.value },
    at: Date.now(), checkedAt: Date.now(), status: "live", txid: null,
  };
  db.listings.push(listing);
  persist();
  console.log(`market: ${parcel.text} listed for ${price} sats by ${seller}`);
  return publicView(listing);
}

// never hand the signed offer out with the browse list — only on request to buy
const publicView = ({ psbt, ...l }) => l;

/**
 * Live listings, each re-checked against the chain. A parcel that moved since
 * it was listed is marked sold/withdrawn rather than shown as buyable.
 */
export async function liveListings() {
  const out = [];
  let changed = false;
  for (const l of db.listings) {
    if (l.status !== "live") { out.push(publicView(l)); continue; }
    if (Date.now() - l.checkedAt > FRESH_MS) {
      const utxo = await liveUtxo(l.inscriptionId).catch(() => null);
      l.checkedAt = Date.now();
      changed = true;
      if (utxo?.address && utxo.address !== l.seller) {
        l.status = "gone";              // sold or moved — either way not for sale here
        console.log(`market: ${l.parcel} left ${l.seller}, listing closed`);
      } else if (utxo && (utxo.txid !== l.utxo.txid || utxo.vout !== l.utxo.vout)) {
        l.status = "stale";             // same owner, different UTXO: the offer can't be spent
      }
    }
    out.push(publicView(l));
  }
  if (changed) persist();
  return out.sort((a, b) => (a.status === "live" ? -1 : 1) - (b.status === "live" ? -1 : 1) || a.priceSats - b.priceSats);
}

// The signed offer, handed over only when someone actually wants to buy it.
export function offerFor(id) {
  const l = db.listings.find((x) => x.id === id);
  if (!l) bad("that listing is gone", 404);
  if (l.status !== "live") bad("that parcel is no longer for sale", 409);
  return l;
}

export function delist(id, who, { isAdmin = false } = {}) {
  const l = db.listings.find((x) => x.id === id);
  if (!l) bad("that listing is gone", 404);
  if (!isAdmin && l.seller !== who) bad("that is not your listing", 403);
  db.listings = db.listings.filter((x) => x.id !== id);
  persist();
  return true;
}

// A buyer broadcast the completed transaction — record it and close the offer.
export function markSold(id, txid) {
  if (!/^[a-f0-9]{64}$/i.test(String(txid || ""))) bad("that is not a transaction id");
  const l = db.listings.find((x) => x.id === id);
  if (!l) bad("that listing is gone", 404);
  l.status = "sold";
  l.txid = txid;
  l.soldAt = Date.now();
  persist();
  console.log(`market: ${l.parcel} sold for ${l.priceSats} sats (${txid})`);
  return publicView(l);
}

export const marketStats = () => {
  const live = db.listings.filter((l) => l.status === "live");
  const sold = db.listings.filter((l) => l.status === "sold");
  return {
    live: live.length,
    sold: sold.length,
    floor: live.length ? Math.min(...live.map((l) => l.priceSats)) : 0,
    volume: sold.reduce((s, l) => s + l.priceSats, 0),
  };
};

export const allListings = () => db.listings.map(publicView);
