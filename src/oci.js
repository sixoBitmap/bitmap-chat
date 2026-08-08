// ON-CHAIN BITMAP INDEX (bitmap number -> canonical inscription id).
//
// Trimmed copy of btcmail's OCI.js for bitmap-ai-chat, tracking the OCI module
// inscribed at 942b5886…62dbi0 ("second post-840k addition", 0-941,999). The
// index itself lives on Bitcoin: 11 inscribed pages. Pages 0-8 hold
// delta-encoded sat numbers plus their positions within a 100k block; pages 9
// and 10 are JSON ({startIndex, deltaEncodedSats, satIndexMap}) covering
// 840,000-906,999 and 907,000-941,999 in order, no position array.
//
// The bitmap inscription is USUALLY the first on its sat, but not always — the
// index ships the exceptions (satIndices below / satIndexMap on pages 9-10),
// so the lookup is:
//
//   number -> page -> sat -> GET /r/sat/<sat>/at/<satIndex> -> inscription id
//
// The index's own author calls the post-840k data unvalidated ("there are
// still discrepancies, always DYOR"), so treat high bitmaps as best-effort.
//
// bitmap-ai-chat changes vs the original:
//   - EVERY call goes through the ord recursive API (/r/*, /content/*) on
//     ordinals.com by default. ORD_API env overrides the gateway list (e.g.
//     a self-hosted ord node — identical recursive API surface).
//   - Xverse-API and mempool.space helpers removed (non-recursive APIs).
//   - fetchOrd errors carry .status and .retryAfter; a 429 puts the gateway
//     on cooldown so the caller's retry layer waits instead of hammering.
//   - fetchOrdBinary() added for image /content/<id> fetches.
//   - topAncestor / isCanonicalBitmapParent / describeInscriptions exported.

// bitmap-ai-chat: ordinals.com recursive API only (no ord.xverse.app fallback)
const DEFAULT_GATEWAYS = ["https://ordinals.com"];
const GATEWAYS = (process.env.ORD_API || DEFAULT_GATEWAYS.join(","))
  .split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
let preferredGateway = 0; // sticky: once a gateway works, keep using it

const BITMAP_INDEX_URLS = [
  "/content/01bba6c58af39d7f199aa2bceeaaba1ba91b23d2663bc4ef079a4b5e442dbf74i0",
  "/content/bb01dfa977a5cd0ee6e900f1d1f896b5ec4b1e3c7b18f09c952f25af6591809fi0",
  "/content/bb02e94f3062facf6aa2e47eeed348d017fd31c97614170dddb58fc59da304efi0",
  "/content/bb037ec98e6700e8415f95d1f5ca1fe1ba23a3f0c5cb7284d877e9ac418d0d32i0",
  "/content/bb9438f4345f223c6f4f92adf6db12a82c45d1724019ecd7b6af4fcc3f5786cei0",
  "/content/bb0542d4606a9e7eb4f31051e91f7696040db06ca1383dff98505618c34d7df7i0",
  "/content/bb06a4dffba42b6b513ddee452b40a67688562be4a1345127e4d57269e6b2ab6i0",
  "/content/bb076934c1c22007b315dd1dc0f8c4a2f9d52f348320cfbadc7c0bd99eaa5e18i0",
  // page 8 was re-inscribed (the newer index points at this one, not bb084ed0…)
  "/content/bb986a1208380ec7db8df55a01c88c73a581069a51b5a2eb2734b41ba10b65c2i0",
  "/content/b907b51a239e3a37f29f8222fb274f828c6ebf7b93ce501a55b7171daaa75758i0", // 840,000-906,999
  "/content/b942b6477c7da9090edb9751429ba9c3ba01b39ab972fc888d481f528e3e03c3i0", // 907,000-941,999
];
// Pages 9 and 10 are ranges, not 100k blocks, and they OVERRIDE page 8 where
// they overlap (840,000-899,999) — same routing the on-chain module uses.
const RANGE_PAGES = [
  { page: 9, from: 840_000, to: 906_999 },
  { page: 10, from: 907_000, to: 941_999 },
];
export const MAX_INDEXED_BITMAP = RANGE_PAGES[RANGE_PAGES.length - 1].to;

// Bitmaps that are NOT the first inscription on their sat (below 840,000).
// Straight from the on-chain module — data credited there to @_lefrog.
const satIndices = {
  92871: 1, 92970: 1, 123132: 1, 365518: 1, 700181: 1, 826151: 1, 827151: 1,
  828151: 1, 828239: 1, 828661: 1, 829151: 1, 830151: 1, 832104: 2, 832249: 2,
  832252: 2, 832385: 4, 833067: 1, 833101: 3, 833105: 4, 833109: 4, 833121: 8,
  834030: 2, 834036: 2, 834051: 17, 834073: 4, 836151: 1, 837115: 2, 837120: 2,
  837151: 1, 837183: 3, 837188: 2, 838058: 5, 838068: 2, 838076: 2, 838096: 1,
  838151: 1, 838821: 1, 839151: 1, 839377: 1, 839378: 2, 839382: 2, 839397: 1,
  840151: 1, 841151: 1, 842151: 1, 845151: 1,
};
// Above 840,000 the exceptions ride along with the page (satIndexMap).
const rangeSatIndices = new Map(); // page -> { bitmapNumber: satIndex }

const bitmapIndexPages = Array(BITMAP_INDEX_URLS.length).fill(null);
const pageLoads = new Map(); // in-flight fetches, so concurrent resolves share one download

// Some public ord instances sit behind bot protection that rejects requests
// without a browser-like User-Agent.
const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; bitmap-ai-chat) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Accept": "*/*",
};

// bitmap-ai-chat: per-gateway 429 cooldown. With a single gateway there is no
// "next gateway" to rotate to — the thrown error carries retryAfter so the
// crawler's withRetry() waits it out.
const gatewayCooldown = new Map(); // gw -> epoch ms until which we skip it

// Fetch `path` from the first usable gateway, sticking with whichever worked
// last. Returns the raw Response; throws with .status/.retryAfter/.notFound.
async function fetchOrdResponse(path) {
  let lastErr;
  for (let i = 0; i < GATEWAYS.length; i++) {
    const gw = GATEWAYS[(preferredGateway + i) % GATEWAYS.length];
    const coolUntil = gatewayCooldown.get(gw) || 0;
    if (coolUntil > Date.now()) {
      const e = new Error(`gateway ${gw} cooling down after 429`);
      e.status = 429;
      e.retryAfter = Math.ceil((coolUntil - Date.now()) / 1000);
      lastErr = e;
      continue;
    }
    try {
      const res = await fetch(gw + path, { headers: FETCH_HEADERS });
      if (res.status === 404) {
        preferredGateway = GATEWAYS.indexOf(gw);
        const e = new Error(`ord 404 on ${path}`);
        e.notFound = true;
        e.status = 404;
        throw e;
      }
      if (!res.ok) {
        const e = new Error(`ord ${res.status} on ${path} via ${gw}`);
        e.status = res.status;
        e.retryAfter = Number(res.headers.get("retry-after")) || null;
        if (res.status === 429) {
          // cap the cooldown: an hours-long Retry-After must not freeze crawls
          gatewayCooldown.set(gw, Date.now() + Math.min(e.retryAfter ? e.retryAfter * 1000 : 30_000, 120_000));
        }
        throw e;
      }
      preferredGateway = GATEWAYS.indexOf(gw);
      return res;
    } catch (e) {
      if (e.notFound) throw e; // a healthy gateway said "does not exist" — don't retry others
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function fetchOrd(path, { as = "json" } = {}) {
  const res = await fetchOrdResponse(path);
  return as === "text" ? res.text() : res.json();
}

// bitmap-ai-chat: binary content fetch (images) — same gateway handling.
export async function fetchOrdBinary(path) {
  const res = await fetchOrdResponse(path);
  return {
    buf: Buffer.from(await res.arrayBuffer()),
    contentType: (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase(),
  };
}

const fetchJson = (path) => fetchOrd(path, { as: "json" });

// deltas -> absolute sat numbers
const undelta = (deltas) => {
  const out = [];
  for (let i = 0; i < deltas.length; i++) {
    out.push(i === 0 ? parseInt(deltas[i]) : out[i - 1] + parseInt(deltas[i]));
  }
  return out;
};

// Page decoding kept verbatim from the inscribed-index consumer code
// (pages 2 and 3 were inscribed as bare comma-separated lists; pages 9 and 10
// are JSON objects listing their range in order).
async function fillIndexPage(page) {
  const range = RANGE_PAGES.find((r) => r.page === page);
  if (range) {
    const j = await fetchOrd(BITMAP_INDEX_URLS[page], { as: "json" });
    rangeSatIndices.set(page, j.satIndexMap || {});
    bitmapIndexPages[page] = undelta(j.deltaEncodedSats || []);
    return;
  }
  let data = await fetchOrd(BITMAP_INDEX_URLS[page], { as: "text" });
  if (page === 2 || page === 3) {
    data = JSON.parse("[" + data + "]");
    data = [data.slice(0, 99999), data.slice(100000, 199999)];
  } else {
    try { data = JSON.parse(data.replaceAll("\n  ", "")); } catch {}
    try { data = JSON.parse(data.replaceAll("  ", "")); } catch {}
  }
  const fullSats = undelta(data[0]);
  const filledArray = Array(100000).fill(0);
  data[1].forEach((index, i) => { filledArray[index] = fullSats[i]; });
  bitmapIndexPages[page] = filledArray;
}

async function ensurePage(page) {
  if (bitmapIndexPages[page]) return;
  if (!pageLoads.has(page)) {
    pageLoads.set(page, fillIndexPage(page).finally(() => pageLoads.delete(page)));
  }
  await pageLoads.get(page);
}

// Which page holds this bitmap, and where in it. Ranges win over 100k blocks.
function locate(n) {
  const range = RANGE_PAGES.find((r) => n >= r.from && n <= r.to);
  if (range) return { page: range.page, slot: n - range.from };
  return { page: Math.floor(n / 100000), slot: n % 100000 };
}

export async function getBitmapSat(bitmapNumber) {
  const n = Number(bitmapNumber);
  if (!Number.isInteger(n) || n < 0 || n > MAX_INDEXED_BITMAP) {
    throw new Error(`bitmap ${bitmapNumber} is outside the on-chain index (covers 0-${MAX_INDEXED_BITMAP})`);
  }
  const { page, slot } = locate(n);
  await ensurePage(page);
  return bitmapIndexPages[page][slot];
}

// Most bitmaps are the first inscription on their sat; these are the ones that
// are not. Call only after the bitmap's page is loaded (getBitmapSat does it).
export function getBitmapSatIndex(bitmapNumber) {
  const n = Number(bitmapNumber);
  const range = RANGE_PAGES.find((r) => n >= r.from && n <= r.to);
  if (range) return Number(rangeSatIndices.get(range.page)?.[n]) || 0;
  return satIndices[n] || 0;
}

export async function getBitmapInscriptionId(bitmapNumber) {
  const sat = await getBitmapSat(bitmapNumber);
  if (!sat) throw new Error(`bitmap ${bitmapNumber} not found in the on-chain index`);
  const res = await fetchJson(`/r/sat/${sat}/at/${getBitmapSatIndex(bitmapNumber)}`);
  if (!res || !res.id) throw new Error(`no inscription found on sat ${sat}`);
  return res.id;
}

// number -> { inscriptionId, owner, inscriptionNumber } via recursive API only.
export async function resolveBitmapOnchainStrict(bitmapNumber) {
  const inscriptionId = await getBitmapInscriptionId(bitmapNumber);
  const insc = await fetchJson(`/r/inscription/${inscriptionId}`);
  if (!insc.address) throw new Error(`inscription ${inscriptionId} has no address (nonstandard output?)`);
  return { inscriptionId, owner: insc.address, inscriptionNumber: insc.number };
}

// Children of a bitmap inscription may list OTHER inscriptions as parents
// (multi-parent parcels etc). A co-parent can itself be a child deeper in a
// parent/child tree, so climb the first-parent chain upward to the tree's
// ROOT — that top parent is the real neighbor district.
export async function topAncestor(pid) {
  let cur = pid;
  for (let hop = 0; hop < 8; hop++) {
    let j = null;
    try { j = await fetchOrd(`/r/parents/${cur}`); } catch { break; }
    const up = (j?.ids || [])[0];
    if (!up || up === cur) break;
    cur = up;
  }
  return cur;
}

// Is `pid` a canonical "<n>.bitmap"? Returns { bitmap, inscriptionId, owner }
// or null. Uses only /r/inscription + /content + the inscribed index.
export async function isCanonicalBitmapParent(pid) {
  let meta;
  try { meta = await fetchOrd(`/r/inscription/${pid}`); } catch { return null; }
  if (!meta || meta.content_length == null || meta.content_length > 20) return null;
  let text;
  try { text = (await fetchOrd(`/content/${pid}`, { as: "text" })).trim(); } catch { return null; }
  const m = /^(\d{1,10})\.bitmap$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (n <= MAX_INDEXED_BITMAP) {
    // Reject only when the index NAMES A DIFFERENT genesis inscription.
    // Gaps happen (e.g. bitmap 834618 has no sat in the inscribed index):
    // then we trust the parent link, same as bitmaps beyond the index —
    // children of a bitmap can only be inscribed by its own holder anyway.
    let canonical = null;
    try { canonical = await getBitmapInscriptionId(n); } catch { /* index gap or gateway hiccup */ }
    if (canonical && canonical !== pid) return null;
  }
  return { bitmap: n, inscriptionId: pid, owner: meta.address ?? null };
}

// [ids] -> [{ id, number }] via /r/inscription, order preserved, failures kept as number:null
export async function describeInscriptions(ids) {
  const CHUNK = 8, out = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const metas = await Promise.all(ids.slice(i, i + CHUNK).map((id) => fetchOrd(`/r/inscription/${id}`).catch(() => null)));
    metas.forEach((m, k) => out.push({ id: ids[i + k], number: m?.number ?? null }));
  }
  return out;
}
