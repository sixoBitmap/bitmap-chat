// Manually claimed PathScribers: address -> inscription ids.
//
// The wallet scan finds PathScribers by walking the address's inscription
// UTXOs, which can miss one (Xverse's index lagging a fresh mint, or a wallet
// with more text inscriptions than the scan's candidate cap). So a holder can
// paste the mint's inscription id instead: the server checks the content AND
// that the address owns it, then remembers the pair here.
//
// A claim is only ever a POINTER. Ownership and content are re-verified on
// every wallet scan, so selling the PathScriber stops the access immediately —
// this file can never grant anything on its own.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.CLAIMS_FILE || path.join(HERE, "..", ".claims.json");

let db = { claims: [] }; // [{ id, address, at }]
try {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  if (Array.isArray(raw?.claims)) db.claims = raw.claims;
} catch { /* first run */ }

function persist() {
  try { fs.writeFileSync(FILE, JSON.stringify(db, null, 1)); }
  catch (e) { console.error("claims: persist failed —", e?.message); }
}

// ids this address has claimed (order kept: oldest first)
export const claimedBy = (address) =>
  db.claims.filter((c) => c.address === address).map((c) => c.id);

// Who claimed each id, for the admin panel. id -> { address, at }
export function claimIndex() {
  const out = {};
  for (const c of db.claims) out[c.id] = { address: c.address, at: c.at };
  return out;
}

// One id belongs to one address: re-claiming after a sale moves it.
export function addClaim(address, id) {
  db.claims = db.claims.filter((c) => c.id !== id);
  db.claims.push({ id, address, at: Date.now() });
  persist();
  return claimedBy(address);
}

export function removeClaim(id) {
  const before = db.claims.length;
  db.claims = db.claims.filter((c) => c.id !== id);
  if (db.claims.length !== before) persist();
  return before !== db.claims.length;
}

export const allClaims = () => [...db.claims].sort((a, b) => b.at - a.at);
