// Free daily questions: everyone who signs in gets one as a gift, plus one
// more for EVERY PathScriber and every 114588 parcel their wallet holds (the
// allowance itself is computed from the wallet scan — see wallet.js).
//
// This ledger only counts how many of them an address has spent today. It is
// deliberately separate from bought questions (orders.js) so the two never mix.
// Persisted to disk so restarts don't hand out a fresh allowance.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = process.env.QUOTA_FILE ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".free-quota.json");

const today = () => new Date().toISOString().slice(0, 10); // UTC day

let map = new Map(); // address -> { day: "YYYY-MM-DD", used: n }
try {
  for (const [addr, v] of Object.entries(JSON.parse(fs.readFileSync(FILE, "utf8")))) {
    // older builds stored just the day string, meaning "the one free question is used"
    map.set(addr, typeof v === "string" ? { day: v, used: 1 } : { day: v.day, used: Number(v.used) || 0 });
  }
} catch { /* first run */ }

function persist() {
  try {
    const t = today();
    for (const [a, e] of map) if (e.day !== t) map.delete(a); // prune old days — the file stays tiny
    fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(map)));
  } catch (e) {
    console.warn("quota persist failed:", e?.message);
  }
}

// How many free questions this address has already used today.
export function freeUsedToday(addr) {
  const e = map.get(addr);
  return e && e.day === today() ? e.used : 0;
}

export function useFree(addr) {
  map.set(addr, { day: today(), used: freeUsedToday(addr) + 1 });
  persist();
}

// Give one back when the question produced nothing (API error, refusal).
export function refundFree(addr) {
  const used = freeUsedToday(addr);
  if (used <= 0) return;
  map.set(addr, { day: today(), used: used - 1 });
  persist();
}
