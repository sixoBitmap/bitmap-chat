// Bug reports from signed-in visitors.
//
// The reporter never types their address — the server takes it from their
// proven wallet session, so a report can't be filed under someone else's name.
// Only the admin panel can read or delete them.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.BUGS_FILE || path.join(HERE, "..", ".bugs.json");

export const BUG_MAX = Number(process.env.BUG_MAX_CHARS) || 2000;
const KEEP = Number(process.env.BUG_KEEP) || 500; // oldest fall off beyond this

let db = { bugs: [] }; // [{ id, address, text, at }]
try {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  if (Array.isArray(raw?.bugs)) db.bugs = raw.bugs;
} catch { /* first run */ }

function persist() {
  try { fs.writeFileSync(FILE, JSON.stringify(db, null, 1)); }
  catch (e) { console.error("bugs: persist failed —", e?.message); }
}

export function addBug(address, rawText) {
  const text = String(rawText ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length < 3) throw Object.assign(new Error("tell us what went wrong first"), { code: 400 });
  if (text.length > BUG_MAX) throw Object.assign(new Error(`that is too long (${text.length} of ${BUG_MAX} characters)`), { code: 400 });
  const bug = { id: "bug_" + crypto.randomBytes(6).toString("hex"), address, text, at: Date.now() };
  db.bugs.push(bug);
  if (db.bugs.length > KEEP) db.bugs = db.bugs.slice(-KEEP);
  persist();
  console.log(`bug report from ${address}: ${text.slice(0, 80).replace(/\n/g, " ")}`);
  return bug;
}

export const listBugs = () => [...db.bugs].sort((a, b) => b.at - a.at);

export function deleteBug(id) {
  const before = db.bugs.length;
  db.bugs = db.bugs.filter((b) => b.id !== id);
  if (db.bugs.length !== before) persist();
  return before !== db.bugs.length;
}

// how many, and how many people sent them — for the admin dashboard
export const bugStats = () => ({
  total: db.bugs.length,
  reporters: new Set(db.bugs.map((b) => b.address)).size,
});
