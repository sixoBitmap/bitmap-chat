// Admin control panel: promo codes, PathScriber / parcel registries, and who
// is allowed in.
//
// ACCESS = the wallet that currently owns the gate bitmap (114588) — read live
// from the chain, so it follows the bitmap if it is ever sold — plus any
// address the owner grants from inside the panel. On top of that every admin
// request must carry the secret ADMIN_CODE. No code set = no admin panel.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { fetchOrd, getBitmapInscriptionId } from "./oci.js";
import { GATE_BITMAP, PATHSCRIBE_SOURCE } from "./wallet.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.ADMIN_FILE || path.join(HERE, "..", ".admin.json");
export const ADMIN_CODE = process.env.ADMIN_CODE || "";
export const adminEnabled = () => ADMIN_CODE.length >= 4;

// PathScriber mints verified on-chain (content === "/content/<original>").
// BRC-420 mints are standalone inscriptions — not children of the deploy — so
// they cannot be enumerated from ord. This seed list is the known supply;
// newly minted ones are picked up automatically when a holder signs in, and
// the admin can add any id by hand.
const SEED_SCRIBERS = [
  "9b14350c99e5ed5692a5eee31e3535bd2a35c0d5a2cbc152616d46fee0826faci0",
  "0272430210713042ee30fd8e619facb11249acc2dff1e50bbf801d91e7bbab31i0",
  "f72835ba47029323f6f99b6ed05c930ab85894a50c1ac24526bfb90b6ff82b7di0",
  "673f9e5fb63bf5ce98e341f9dcfd60aa010522a435158ee63850e3d4ca75ac8fi0",
  "9cb1b1485fc5df1109236ddd6e7ecdbdd830674a881c0b12f2233c5b930ea082i0",
  "c35cb7743712dbcc7e674a42cc87397a3a1c96afeca84f901ca28c0d630f3d1di0",
  "3be5d0291a3c84cca8fdd35345a686635d516875870fbdcd3e0ed9c539328e79i0",
  "620c9f7b4032a4296fa77f27f24d6b7c5c0b3956f727774ab9200c38cdfbdd83i0",
  "88357842fc613bb176b00ff0f837e0a1d9db625a03fed4be088dc030c3a05cc4i0",
  "0d1c07026d0716bab25090d66552ebaf523a9e9af894f1edff36074818644849i0",
  "9cd5fc83f8054785d4b2a2c3a226a500035556d40387d607850c0acf935578e2i0",
  "409b46ff982d61f2fff70def7b2df5aee1a637243ab8a037df8d23e4f864ee19i0",
  "b2a6d9ffe056dee455a300901a6936cfa346ec8639d183a679a764aede35c13bi0",
];

const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

// --- store ------------------------------------------------------------------
let db = { promos: {}, admins: [], scribers: [] };
try { db = { promos: {}, admins: [], scribers: [], ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { /* first run */ }
// the original secret code ships enabled and never-expiring unless changed
if (!Object.keys(db.promos).length) {
  db.promos["be the bitmap"] = { discountPct: 50, createdAt: Date.now(), expiresAt: null, active: true, perAddress: 1, maxTotal: 0 };
}
// codes written by older builds had no usage limits — one per address is the
// default, matching what the panel now creates
for (const p of Object.values(db.promos)) {
  if (typeof p.perAddress !== "number") p.perAddress = 1;
  if (typeof p.maxTotal !== "number") p.maxTotal = 0;
}
for (const id of SEED_SCRIBERS) if (!db.scribers.includes(id)) db.scribers.push(id);

function persist() {
  try { fs.writeFileSync(FILE, JSON.stringify(db, null, 1)); }
  catch (e) { console.error("admin: persist failed —", e?.message); }
}
persist();

// --- who is an admin --------------------------------------------------------
let ownerCache = { at: 0, address: null };
export async function gateOwner() {
  if (ownerCache.address && Date.now() - ownerCache.at < 5 * 60_000) return ownerCache.address;
  const id = await getBitmapInscriptionId(GATE_BITMAP);
  const meta = await fetchOrd(`/r/inscription/${id}`);
  if (meta?.address) ownerCache = { at: Date.now(), address: meta.address };
  return ownerCache.address;
}

export async function isAdmin(address) {
  if (!address) return false;
  if (db.admins.includes(address)) return true;
  try { return (await gateOwner()) === address; } catch { return false; }
}

export const listAdmins = () => [...db.admins];
export function grantAdmin(address) {
  if (!/^(bc1[a-z0-9]{20,90}|[13][a-zA-Z0-9]{25,40})$/.test(String(address || ""))) {
    throw Object.assign(new Error("that doesn't look like a Bitcoin address"), { code: 400 });
  }
  if (!db.admins.includes(address)) { db.admins.push(address); persist(); }
  return listAdmins();
}
export function revokeAdmin(address) {
  db.admins = db.admins.filter((a) => a !== address);
  persist();
  return listAdmins();
}

// --- promo codes ------------------------------------------------------------
const promoLive = (p) => p.active !== false && (!p.expiresAt || p.expiresAt > Date.now());

// How often a code may be redeemed. Both are "0 = unlimited":
//   perAddress — times ONE wallet may use it (default 1: once each)
//   maxTotal   — redemptions across all wallets before the code is spent
const limit = (v, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

// Used by the buy flow. Returns the discount + its usage limits, or null.
// Counting the redemptions is orders.js's job (it owns the order history).
export function lookupPromo(code) {
  const p = db.promos[norm(code)];
  if (!p || !promoLive(p)) return null;
  return {
    mult: 1 - p.discountPct / 100,
    discountPct: p.discountPct,
    perAddress: limit(p.perAddress, 1),
    maxTotal: limit(p.maxTotal, 0),
  };
}

export function listPromos() {
  return Object.entries(db.promos).map(([code, p]) => ({
    code, discountPct: p.discountPct, createdAt: p.createdAt,
    expiresAt: p.expiresAt ?? null, active: p.active !== false, live: promoLive(p),
    perAddress: limit(p.perAddress, 1), maxTotal: limit(p.maxTotal, 0),
  })).sort((a, b) => b.createdAt - a.createdAt);
}

export function createPromo({ code, discountPct, days, perAddress, maxTotal }) {
  const c = norm(code);
  if (c.length < 3) throw Object.assign(new Error("the code needs at least 3 characters"), { code: 400 });
  const pct = Math.round(Number(discountPct));
  if (!(pct >= 1 && pct <= 100)) throw Object.assign(new Error("discount must be between 1 and 100%"), { code: 400 });
  const d = Number(days);
  db.promos[c] = {
    discountPct: pct,
    createdAt: Date.now(),
    expiresAt: d > 0 ? Date.now() + d * 86_400_000 : null, // 0/blank = never expires
    active: true,
    perAddress: limit(perAddress, 1),
    maxTotal: limit(maxTotal, 0),
  };
  persist();
  return listPromos();
}

// Change how many times an existing code may be used, without touching its
// discount, creation date or expiry.
export function setPromoLimits(code, { perAddress, maxTotal }) {
  const p = db.promos[norm(code)];
  if (!p) throw Object.assign(new Error("no such code"), { code: 404 });
  if (perAddress !== undefined) p.perAddress = limit(perAddress, p.perAddress ?? 1);
  if (maxTotal !== undefined) p.maxTotal = limit(maxTotal, p.maxTotal ?? 0);
  persist();
  return listPromos();
}

export function setPromoActive(code, active) {
  const p = db.promos[norm(code)];
  if (!p) throw Object.assign(new Error("no such code"), { code: 404 });
  p.active = !!active;
  persist();
  return listPromos();
}

export function deletePromo(code) {
  delete db.promos[norm(code)];
  persist();
  return listPromos();
}

// --- PathScriber registry ---------------------------------------------------
export function registerScriber(id) {
  if (id && !db.scribers.includes(id)) { db.scribers.push(id); persist(); }
}
export const knownScriberIds = () => [...db.scribers];

// id -> current owner, straight from the recursive API (chunked, tolerant)
export async function describeHolders(ids) {
  const out = [];
  const CHUNK = 8;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const metas = await Promise.all(ids.slice(i, i + CHUNK).map((id) =>
      fetchOrd(`/r/inscription/${id}`).catch(() => null)));
    metas.forEach((m, k) => out.push({
      id: ids[i + k], number: m?.number ?? null, owner: m?.address ?? null,
      timestamp: m?.timestamp ?? null,
    }));
  }
  return out.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));
}

export async function pathscriberHolders() {
  const rows = await describeHolders(knownScriberIds());
  return { source: PATHSCRIBE_SOURCE, total: rows.length, holders: new Set(rows.map((r) => r.owner).filter(Boolean)).size, rows };
}
