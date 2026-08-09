// District art: a block drawn as a Mondrian mosaic of its transactions.
//
// Every transaction becomes a square sized by its total output value, and the
// squares are packed with mononaut's Mondrian layout (written for bitfeed,
// carried into the bitmap world by the on-chain module 55551557…666c3ai0 that
// SimpleBitmap uses). Both are reimplemented here rather than imported: the
// page that shows this also holds wallet sessions, and third-party script in
// it is not a trade worth making.
//
// The heavy part is the data — every transaction's outputs, which means the
// whole raw block. A mined block never changes, so each one is fetched and
// laid out exactly ONCE and then served from cache forever.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.BLOCKART_FILE || path.join(HERE, "..", ".blockart.json");
const SOURCE = (process.env.BLOCK_API || "https://blockchain.info").replace(/\/$/, "");
const KEEP = Number(process.env.BLOCKART_KEEP) || 400; // least-recently-used fall off
const MAX_TX = Number(process.env.BLOCKART_MAX_TX) || 12_000; // sanity bound

// value in sats -> square edge. Straight from the on-chain module.
export function squareSize(sats) {
  const btc = sats / 100_000_000;
  if (btc <= 0.01) return 1;
  if (btc <= 0.1) return 2;
  if (btc <= 1) return 3;
  if (btc <= 10) return 4;
  if (btc <= 100) return 5;
  if (btc <= 1000) return 6;
  if (btc <= 10_000) return 7;
  if (btc <= 100_000) return 8;
  return 9;
}

// mononaut's Mondrian packing: squares dropped into the first slot that fits,
// the slot map repaired around each placement.
export function mondrian(sizes) {
  const length = Math.ceil(Math.sqrt(sizes.reduce((s, n) => s + n * n, 0)));
  const rows = [];
  const placed = [];
  let width = 0, height = 0;

  const getRow = (y) => (y < rows.length ? rows[y] : null);
  const addRow = () => { const r = { y: rows.length, slots: [], map: new Map() }; rows.push(r); return r; };
  const removeSlot = (slot) => {
    const row = getRow(slot.position.y);
    if (!row) return;
    row.map.delete(slot.position.x);
    const i = row.slots.findIndex((s) => s.position.x === slot.position.x);
    if (i !== -1) row.slots.splice(i, 1);
  };
  const addSlot = (slot) => {
    if (slot.size <= 0) return null;
    const row = getRow(slot.position.y);
    if (!row) return null;
    const existing = row.map.get(slot.position.x);
    if (existing) { existing.size = Math.max(existing.size, slot.size); return existing; }
    const at = row.slots.findIndex((s) => s.position.x > slot.position.x);
    if (at === -1) row.slots.push(slot); else row.slots.splice(at, 0, slot);
    row.map.set(slot.position.x, slot);
    return slot;
  };

  function fillSlot(slot, w) {
    const sq = { left: slot.position.x, right: slot.position.x + w, bottom: slot.position.y, top: slot.position.y + w };
    removeSlot(slot);
    for (let y = slot.position.y; y < sq.top; y++) {
      const row = getRow(y);
      if (row) {
        const hits = [];
        let maxExcess = 0;
        for (const t of row.slots) {
          if (!(t.position.x + t.size < sq.left || t.position.x >= sq.right)) {
            hits.push(t);
            maxExcess = Math.max(maxExcess, Math.max(0, t.position.x + t.size - (slot.position.x + slot.size)));
          }
        }
        if (sq.right < length && !row.map.has(sq.right)) {
          addSlot({ position: { x: sq.right, y }, size: slot.size - w + maxExcess });
        }
        for (const h of hits) {
          h.size = slot.position.x - h.position.x;
          if (h.size === 0) removeSlot(h);
        }
      } else {
        addRow();
        if (slot.position.x > 0) addSlot({ position: { x: 0, y }, size: slot.position.x });
        if (sq.right < length) addSlot({ position: { x: sq.right, y }, size: length - sq.right });
      }
    }
    // repair the rows above: squares that now overlap get trimmed, and the
    // leftover L-shape is re-cut into slots
    for (let y = Math.max(0, slot.position.y - w); y < slot.position.y; y++) {
      const row = getRow(y);
      if (!row) continue;
      for (const t of [...row.slots]) {
        if (t.position.x < slot.position.x + w && t.position.x + t.size > slot.position.x &&
            t.position.y + t.size >= slot.position.y) {
          const was = t.size;
          t.size = slot.position.y - t.position.y;
          const rest = { x: t.position.x + t.size, y: t.position.y, width: was - t.size, height: t.size };
          while (rest.width > 0 && rest.height > 0) {
            if (rest.width <= rest.height) {
              addSlot({ position: { x: rest.x, y: rest.y }, size: rest.width });
              rest.y += rest.width; rest.height -= rest.width;
            } else {
              addSlot({ position: { x: rest.x, y: rest.y }, size: rest.height });
              rest.x += rest.height; rest.width -= rest.height;
            }
          }
        }
      }
    }
    return { position: slot.position, size: w };
  }

  for (const size of sizes) {
    let square = null;
    outer: for (const row of rows) {
      for (const slot of row.slots) {
        if (slot.size >= size) { square = fillSlot(slot, size); break outer; }
      }
    }
    if (!square) {
      const row = addRow();
      square = fillSlot(addSlot({ position: { x: 0, y: row.y }, size: length }), size);
    }
    width = Math.max(width, square.position.x + square.size);
    height = Math.max(height, square.position.y + square.size);
    placed.push(square.position.x, square.position.y, square.size);
  }
  return { width, height, slots: placed };
}

// --- cache -------------------------------------------------------------------
let db = new Map(); // height -> { w, h, n, slots:[x,y,s,...] }
try {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  for (const [k, v] of Object.entries(raw || {})) db.set(Number(k), v);
} catch { /* first run */ }

let saveTimer = null;
function persistSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      while (db.size > KEEP) db.delete(db.keys().next().value); // Map keeps insertion order
      fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(db)));
    } catch (e) { console.error("blockart: persist failed —", e?.message); }
  }, 2000);
  saveTimer.unref?.();
}

const inflight = new Map();

export async function blockArt(height) {
  const h = Number(height);
  if (!Number.isInteger(h) || h < 0 || h > 2_000_000) {
    throw Object.assign(new Error("that is not a block height"), { code: 400 });
  }
  const hit = db.get(h);
  if (hit) { db.delete(h); db.set(h, hit); return hit; }        // refresh LRU order
  if (inflight.has(h)) return inflight.get(h);

  const job = (async () => {
    const res = await fetch(`${SOURCE}/block-height/${h}?format=json&cors=true`, {
      headers: { "User-Agent": "bitmap-ai-chat", Accept: "application/json" },
    });
    if (!res.ok) throw Object.assign(new Error(`block source ${res.status}`), { code: 502 });
    const j = await res.json();
    const block = (j?.blocks || []).find((b) => b.main_chain !== false) || j?.blocks?.[0];
    if (!block?.tx) throw Object.assign(new Error("that block has no transactions to draw"), { code: 502 });
    if (block.tx.length > MAX_TX) throw Object.assign(new Error("that block is too large to draw"), { code: 413 });

    const sizes = block.tx.map((tx) =>
      squareSize((tx.out || []).reduce((s, o) => s + (o.value || 0), 0)));
    const { width, height: hgt, slots } = mondrian(sizes);
    const art = { w: width, h: hgt, n: block.tx.length, slots };
    db.set(h, art);
    persistSoon();
    console.log(`block art ${h}: ${art.n} transactions -> ${width}x${hgt}`);
    return art;
  })().finally(() => inflight.delete(h));

  inflight.set(h, job);
  return job;
}

export const artCached = (height) => db.has(Number(height));
