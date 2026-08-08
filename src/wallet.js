// Wallet scanning + the pathscribe gate.
//
// Two data sources, deliberately split:
//   - The GATE SET (all parcels/pathscribes of the gate bitmap, default
//     114588.bitmap) comes LIVE from the ordinals.com recursive API
//     (/r/children of the gate bitmap's canonical inscription), short-cached
//     so newly inscribed parcels appear within minutes.
//   - The WALLET'S contents cannot be listed from ordinals.com (its address
//     JSON API is disabled), so the wallet scan uses the same Xverse address
//     API that btcmail uses. Every bitmap candidate found in the wallet is
//     still VERIFIED canonical through the ordinals.com recursive index.
//
// Gate rule: a wallet may scan its OWN bitmaps; holding a PathScriber (a
// BRC-420 mint of the PathScriber original inscription — its content is
// exactly "/content/<PATHSCRIBE_SOURCE>") or a child/parcel of the gate
// bitmap unlocks scanning ANY bitmap.

import { fetchOrd, getBitmapInscriptionId, MAX_INDEXED_BITMAP } from "./oci.js";
import { claimedBy } from "./claims.js";

export const GATE_BITMAP = Number(process.env.GATE_BITMAP) || 114588;
// The PathScriber "Original Inscription" (brc420.io deploy cd63a4…462i0
// points at it); every valid mint's content is "/content/<this id>".
export const PATHSCRIBE_SOURCE = process.env.PATHSCRIBE_SOURCE ||
  "914e2538118b4cffcf1eced6187462eb1ebcfcc95146c027edba78efee00310bi0";
const MINT_CONTENT = `/content/${PATHSCRIBE_SOURCE}`;
// THE PARCEL RULE: a parcel is a CHILD of the gate bitmap's inscription whose
// content is "x.<gate>.bitmap" where x runs from 0 to (transaction count of
// block <gate>) - 1 — block 114588 had 100 txs, so 0.114588.bitmap through
// 99.114588.bitmap and NOTHING else. No leading zeros; and per parcel number
// only the FIRST inscription (lowest inscription number) claiming it counts.
const PARCEL_TEXT_RE = new RegExp(`^(0|[1-9]\\d*)\\.${GATE_BITMAP}\\.bitmap$`);
const XVERSE_API = (process.env.XVERSE_API || "https://api-3.xverse.app").replace(/\/$/, "");
const SCAN_TTL_MS = Number(process.env.WALLET_SCAN_TTL_MS) || 5 * 60 * 1000;
const GATE_TTL_MS = Number(process.env.GATE_CHILDREN_TTL_MS) || 5 * 60 * 1000;

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; bitmap-ai-chat) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Accept": "*/*",
};

export const isBitcoinAddress = (a) =>
  /^(bc1[a-z0-9]{20,90}|[13][a-zA-Z0-9]{25,40})$/.test(String(a || ""));

// --- gate data: canonical parcels of the gate bitmap, live from ordinals.com -
// Children come from /r/children of the gate bitmap's canonical inscription;
// the parcel-number ceiling comes from /r/blockinfo/<gate> transaction_count
// (immutable — fetched once per process); each child's content decides whether
// it claims a parcel number, and the lowest inscription number wins each x.
let gateCache = { at: 0, data: null };
let gateInflight = null;
let blockTxCount = null;
export async function gateData() {
  if (gateCache.data && Date.now() - gateCache.at < GATE_TTL_MS) return gateCache.data;
  if (!gateInflight) {
    gateInflight = (async () => {
      const parentId = await getBitmapInscriptionId(GATE_BITMAP);
      const ids = [];
      for (let page = 0; page < 12; page++) {
        const j = await fetchOrd(`/r/children/${parentId}/${page}`);
        ids.push(...(j.ids || []));
        if (!j.more) break;
      }
      if (blockTxCount == null) {
        blockTxCount = Number((await fetchOrd(`/r/blockinfo/${GATE_BITMAP}`))?.transaction_count) || 0;
      }
      const best = new Map(); // x -> { id, number, text } (first claim wins)
      const CHUNK = 8;
      for (let i = 0; i < ids.length; i += CHUNK) {
        await Promise.all(ids.slice(i, i + CHUNK).map(async (id) => {
          let meta;
          try { meta = await fetchOrd(`/r/inscription/${id}`); } catch { return; }
          if (!meta || meta.content_length == null || meta.content_length > 32) return;
          let text;
          try { text = (await fetchOrd(`/content/${id}`, { as: "text" })).trim(); } catch { return; }
          const m = PARCEL_TEXT_RE.exec(text);
          if (!m) return;                       // e.g. "bless" children are NOT parcels
          const x = Number(m[1]);
          if (x >= blockTxCount) return;        // beyond the block's tx count -> invalid
          const cur = best.get(x);
          if (!cur || (meta.number ?? Infinity) < (cur.number ?? Infinity)) {
            best.set(x, { id, number: meta.number ?? null, text });
          }
        }));
      }
      const parcelById = new Map(); // canonical child id -> { x, text, number }
      for (const [x, v] of best) parcelById.set(v.id, { x, text: v.text, number: v.number });
      const data = { childIds: new Set(ids), parcelById, txCount: blockTxCount };
      gateCache = { at: Date.now(), data };
      console.log(`gate ${GATE_BITMAP}.bitmap: ${ids.length} children, ${parcelById.size}/${blockTxCount} canonical parcels, live from ordinals.com`);
      return data;
    })().finally(() => { gateInflight = null; });
  }
  return gateInflight;
}

// Classify one wallet inscription via the ordinals.com recursive API:
//   { bitmap: n }        — canonical "<n>.bitmap" (verified against the index)
//   { pathscriber: id }  — BRC-420 PathScriber mint (content matches exactly)
//   null                 — neither (parcels are matched by canonical-id
//                          membership in gateData().parcelById, not here)
async function classifyCandidate(id) {
  let meta;
  try { meta = await fetchOrd(`/r/inscription/${id}`); } catch { return null; }
  // bitmaps ≤20B; PathScriber mints are ~75B ("/content/<64hex>i0")
  if (!meta || meta.content_length == null || meta.content_length > 120) return null;
  let text;
  try { text = (await fetchOrd(`/content/${id}`, { as: "text" })).trim(); } catch { return null; }
  if (text === MINT_CONTENT) return { pathscriber: id };
  const m = /^(\d{1,10})\.bitmap$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (n > MAX_INDEXED_BITMAP) return { bitmap: n };    // beyond the index — trust it
  try { return (await getBitmapInscriptionId(n)) === id ? { bitmap: n } : null; } catch { return null; }
}

// A holder can name their PathScriber directly (see claims.js). ONE validator
// for both that route and every later scan, so a claimed mint is held to the
// same standard as one the scan found by itself: right content, and owned by
// this address right now.
export const PATHSCRIBER_ID_RE = /^[a-f0-9]{64}i\d{1,3}$/i;

export async function verifyScriber(id, address) {
  if (!PATHSCRIBER_ID_RE.test(String(id || ""))) {
    return { ok: false, reason: "that is not an inscription id — it looks like 64 letters/numbers, then i0" };
  }
  let meta;
  try { meta = await fetchOrd(`/r/inscription/${id}`); } catch (e) {
    return { ok: false, reason: e?.notFound || e?.status === 404
      ? "ordinals.com doesn't know that inscription yet — if you just minted, give it a few minutes and try again"
      : "could not reach ordinals.com — try again in a moment" };
  }
  if (!meta || meta.content_length == null || meta.content_length > 120) {
    return { ok: false, reason: "that inscription is not a PathScriber mint" };
  }
  let text;
  try { text = (await fetchOrd(`/content/${id}`, { as: "text" })).trim(); } catch {
    return { ok: false, reason: "could not read that inscription's content — try again in a moment" };
  }
  if (text !== MINT_CONTENT) return { ok: false, reason: "that inscription is not a PathScriber mint" };
  if (!meta.address) return { ok: false, reason: "that inscription has no readable owner" };
  if (address && meta.address !== address) {
    return { ok: false, reason: "that PathScriber is not in this wallet — connect the wallet that holds it" };
  }
  return { ok: true, id, owner: meta.address, number: meta.number ?? null };
}

// --- the scan ---------------------------------------------------------------
// Walks the wallet's inscription UTXOs (Xverse address API, btcmail pattern),
// collecting (a) canonical bitmaps it holds and (b) gate-bitmap parcels.
async function scanWalletRaw(address) {
  const PAGE_CAP = 12, CANDIDATE_CAP = 400, CHUNK = 8;
  // canonical parcel set, built live from the gate bitmap's children; if it
  // can't be built, NO parcels are recognized (strict — no false unlocks)
  const gate = await gateData().catch(() => null);
  const bitmapNums = new Set();
  const parcelText = new Map(); // canonical parcel id -> "x.114588.bitmap"
  const scriberIds = new Set();
  let offset = 0, checked = 0;
  for (let page = 0; page < PAGE_CAP; page++) {
    const res = await fetch(
      `${XVERSE_API}/v1/address/${encodeURIComponent(address)}/ordinal-utxo?limit=60&offset=${offset}`,
      { headers: FETCH_HEADERS });
    if (!res.ok) throw new Error(`wallet scan failed (xverse ${res.status})`);
    const j = await res.json();
    const utxos = j.results || [];
    const candidates = [];
    for (const u of utxos) for (const insc of (u.inscriptions || [])) {
      // parcels: exact canonical-id membership — content, childhood, number
      // range, and first-claim-wins were all enforced when the set was built
      if (gate?.parcelById.has(insc.id)) parcelText.set(insc.id, gate.parcelById.get(insc.id).text);
      // bitmaps are text/plain; PathScriber mints are text/html — check both
      if (/^text\/(plain|html)/i.test(insc.content_type || "")) candidates.push(insc.id);
    }
    for (let i = 0; i < candidates.length; i += CHUNK) {
      const batch = candidates.slice(i, i + CHUNK);
      if ((checked += batch.length) > CANDIDATE_CAP) { offset = Infinity; break; }
      const found = await Promise.all(batch.map(classifyCandidate));
      for (const f of found) {
        if (!f) continue;
        if (f.bitmap != null) bitmapNums.add(f.bitmap);
        if (f.pathscriber) {
          scriberIds.add(f.pathscriber);
          // BRC-420 mints can't be enumerated from ord — remember every one we
          // meet so the admin panel's registry grows as holders sign in
          import("./admin.js").then((m) => m.registerScriber(f.pathscriber)).catch(() => {});
        }
      }
    }
    offset += (j.limit ?? utxos.length) || 60;
    if (!utxos.length || offset >= (j.total ?? 0)) break;
  }
  // PathScribers this address claimed by hand: re-verified every scan, so one
  // that has since been sold simply drops out (claims never grant by themselves)
  for (const id of claimedBy(address)) {
    if (scriberIds.has(id)) continue;
    const v = await verifyScriber(id, address).catch(() => ({ ok: false }));
    if (v.ok) scriberIds.add(id);
  }

  // each owned bitmap: preview = the LAST inscription on its sat (/r/sat/<sat>/at/-1
  // — the newest reinscription, or the bitmap itself when none exists)
  const bitmaps = [];
  for (const n of [...bitmapNums].sort((a, b) => a - b)) {
    let previewId = null;
    try {
      if (n <= MAX_INDEXED_BITMAP) {
        const sat = await getBitmapSat(n);
        if (sat) previewId = (await fetchOrd(`/r/sat/${sat}/at/-1`))?.id || null;
      }
    } catch { /* preview is cosmetic */ }
    bitmaps.push({ n, previewId });
  }
  // describe held parcels/pathscribers (inscription numbers) for the picker UI
  const describe = async (ids) => {
    const out = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const metas = await Promise.all(ids.slice(i, i + CHUNK).map((id) => fetchOrd(`/r/inscription/${id}`).catch(() => null)));
      metas.forEach((m, k) => out.push({ id: ids[i + k], number: m?.number ?? null }));
    }
    return out.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));
  };
  const [parcels, pathscribers] = await Promise.all([describe([...parcelText.keys()]), describe([...scriberIds])]);
  for (const p of parcels) p.text = parcelText.get(p.id);
  return {
    address,
    bitmaps,
    parcels,
    pathscribers,
    unlocked: parcels.length > 0 || pathscribers.length > 0,
    gateBitmap: GATE_BITMAP,
    at: Date.now(),
  };
}

// cache + inflight dedupe; `fresh` forces a re-scan (used after a purchase)
const scanCache = new Map();    // address -> scan result
const scanInflight = new Map(); // address -> promise
export async function getWalletScan(address, { fresh = false } = {}) {
  const hit = scanCache.get(address);
  if (!fresh && hit && Date.now() - hit.at < SCAN_TTL_MS) return hit;
  if (!scanInflight.has(address)) {
    scanInflight.set(address, scanWalletRaw(address)
      .then((r) => { scanCache.set(address, r); return r; })
      .finally(() => scanInflight.delete(address)));
  }
  return scanInflight.get(address);
}

// Free-question allowance: 1 for everyone, +1 per PathScriber and +1 per
// gate-bitmap parcel the wallet holds. Reads the LAST known scan (even if
// stale) so a chat request never blocks on a fresh wallet scan; a stale one is
// refreshed in the background for the next call.
export const FREE_BASE = Number(process.env.FREE_BASE) || 1;
const FREE_MAX = Number(process.env.FREE_MAX_PER_DAY) || 0; // 0 = uncapped

const allowanceOf = (scan) => {
  const n = FREE_BASE + (scan?.pathscribers?.length || 0) + (scan?.parcels?.length || 0);
  return FREE_MAX > 0 ? Math.min(n, FREE_MAX) : n;
};

export async function freeAllowance(address) {
  if (!isBitcoinAddress(address)) return FREE_BASE;
  const known = scanCache.get(address);
  if (known) {
    if (Date.now() - known.at >= SCAN_TTL_MS) getWalletScan(address, { fresh: true }).catch(() => {});
    return allowanceOf(known);
  }
  try { return allowanceOf(await getWalletScan(address)); } catch { return FREE_BASE; }
}

// WHO MAY REWRITE WHAT (the 📜 panel). Holding a PathScriber buys the
// top-priority slot, a gate-bitmap parcel buys the bottom one, and holding
// both buys the middle — the house prompt itself, for that reader's own
// questions only (the app-wide prompt stays the admin's).
// Same "last known scan" rule as freeAllowance: never block a chat on a scan.
const rightsOf = (scan) => {
  const above = (scan?.pathscribers?.length || 0) > 0;
  const below = (scan?.parcels?.length || 0) > 0;
  return { above, below, main: above && below };
};
export const NO_PROMPT_RIGHTS = { above: false, below: false, main: false };

export async function promptRights(address) {
  if (!isBitcoinAddress(address)) return NO_PROMPT_RIGHTS;
  const known = scanCache.get(address);
  if (known) {
    if (Date.now() - known.at >= SCAN_TTL_MS) getWalletScan(address, { fresh: true }).catch(() => {});
    return rightsOf(known);
  }
  try { return rightsOf(await getWalletScan(address)); } catch { return NO_PROMPT_RIGHTS; }
}

// Gate check used by the crawl/graph/chat routes. Returns { ok, reason }.
export async function walletMayScan(address, bitmap) {
  if (!isBitcoinAddress(address)) return { ok: false, reason: "sign in with your wallet first" };
  let scan;
  try { scan = await getWalletScan(address); } catch { return { ok: false, reason: "wallet scan failed — try reconnecting" }; }
  if (scan.unlocked) return { ok: true };
  if (scan.bitmaps.some((b) => b.n === Number(bitmap))) return { ok: true };
  return {
    ok: false,
    reason: `your wallet doesn't hold ${bitmap}.bitmap — you can scan your own bitmaps, or own a PathScriber (or ${GATE_BITMAP}.bitmap parcel) to scan any bitmap`,
  };
}
