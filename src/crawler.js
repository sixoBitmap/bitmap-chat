// Recursive family crawler for one bitmap, entirely via ord recursive
// endpoints: children at all depths, parents of every discovered inscription
// (climbed to their district roots), reinscriptions on every discovered sat,
// and the content of small text inscriptions (+ optionally images for Claude).
//
// fetchOrd has no rate-limit handling of its own, so every call here goes
// through a small concurrency pool + retry-with-backoff that honors
// Retry-After. All caps are env-overridable and every truncation is recorded
// in stats.truncated — the model is told exactly what it can't see.

import {
  fetchOrd, fetchOrdBinary, getBitmapSat, getBitmapInscriptionId,
  topAncestor, isCanonicalBitmapParent, MAX_INDEXED_BITMAP,
} from "./oci.js";

const num = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export const CAPS = {
  MAX_NODES: num("CRAWL_MAX_NODES", 1500),
  MAX_DEPTH: num("CRAWL_MAX_DEPTH", 6),
  CHILD_PAGE_CAP: num("CRAWL_CHILD_PAGE_CAP", 10),     // ~100 ids/page -> ~1000 children/node
  PARENT_PAGE_CAP: num("CRAWL_PARENT_PAGE_CAP", 3),
  SAT_SCAN_LIMIT: num("CRAWL_SAT_SCAN_LIMIT", 300),    // nodes that get a reinscription sat-scan
  SAT_PAGE_CAP: num("CRAWL_SAT_PAGE_CAP", 3),
  TEXT_ITEM_CAP: num("CRAWL_TEXT_ITEM_CAP", 10_000),   // bytes per text inscription
  TEXT_TOTAL_CAP: num("CRAWL_TEXT_TOTAL_CAP", 2_000_000),
  IMAGE_CAP: num("CRAWL_IMAGE_CAP", 8),                // images passed to Claude
  IMAGE_MAX_BYTES: num("CRAWL_IMAGE_MAX_BYTES", 1_500_000),
  CONCURRENCY: num("CRAWL_CONCURRENCY", 6),
  TIMEOUT_MS: num("CRAWL_TIMEOUT_MS", 360_000),        // hard wall-clock cap
  TTL_MS: num("CRAWL_TTL_MS", 600_000),                // crawl cache TTL
};

const TEXTY_RE = /^(text\/plain|application\/json|text\/html|image\/svg\+xml)/i;
const CLAUDE_IMG_RE = /^image\/(png|jpeg|gif|webp)$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (id) => String(id).slice(0, 12);

// Tiny semaphore — the ONLY place ord requests gain concurrency.
export function createPool(limit) {
  let active = 0;
  const queue = [];
  const acquire = () => new Promise((resolve) => {
    if (active < limit) { active++; resolve(); }
    else queue.push(resolve);
  });
  const release = () => {
    if (queue.length) queue.shift()();   // hand the slot to the next waiter
    else active--;
  };
  return { async run(fn) { await acquire(); try { return await fn(); } finally { release(); } } };
}

// Retry with exponential backoff + full jitter, honoring Retry-After.
// 404 ("does not exist") returns null immediately; final failure returns null
// too — a crawl degrades node-by-node, it never dies on one bad fetch.
export async function withRetry(fn, { tries = 4, base = 600, onFail, deadline } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { return await fn(); } catch (e) {
      if (e?.notFound) return null;
      if (attempt === tries - 1) { onFail?.(e); return null; }
      let delay = Math.min(15_000, base * 2 ** attempt * (0.5 + Math.random() / 2));
      // honor Retry-After but never sleep more than 30s per attempt, and never
      // sleep past the crawl deadline — a huge Retry-After must not freeze the job
      if (e?.retryAfter) delay = Math.max(Math.min(e.retryAfter * 1000, 30_000), delay);
      if (deadline && Date.now() + delay > deadline) { onFail?.(e); return null; }
      await sleep(delay);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Crawl jobs + cache
// ---------------------------------------------------------------------------

const crawlCache = new Map(); // "bitmap:0|1" -> { at, job }

export function cacheKey(bitmap, includeImages) {
  return `${bitmap}:${includeImages ? 1 : 0}`;
}

// Start (or join) the crawl for a bitmap. Concurrent viewers share one job.
export function getCrawl(bitmap, includeImages) {
  const key = cacheKey(bitmap, includeImages);
  const hit = crawlCache.get(key);
  if (hit && Date.now() - hit.at < CAPS.TTL_MS && !hit.job.state.error) return hit.job;
  const job = createJob(key, bitmap, includeImages);
  crawlCache.set(key, { at: Date.now(), job });
  return job;
}

// Completed graph or null (missing/expired/failed) — chat never re-crawls silently.
export function getCachedGraph(bitmap, includeImages) {
  const hit = crawlCache.get(cacheKey(bitmap, includeImages));
  if (!hit || Date.now() - hit.at >= CAPS.TTL_MS) return null;
  return hit.job.graph || null;
}

function createJob(key, bitmap, includeImages) {
  const job = {
    key,
    state: { phase: "starting", discovered: 0, fetched: 0, contentFetched: 0, images: 0, done: false, error: null },
    graph: null,
    listeners: new Set(),
    subscribe(cb) {
      job.listeners.add(cb);
      // replay current state so late joiners (or reconnects) catch up instantly
      cb("progress", job.state);
      if (job.state.error) cb("error", { message: job.state.error });
      else if (job.state.done) cb("ready", { stats: job.graph.stats, cached: true });
    },
    unsubscribe(cb) { job.listeners.delete(cb); },
    emit(event, payload) { for (const cb of job.listeners) { try { cb(event, payload); } catch {} } },
  };
  job.promise = runCrawl(job, Number(bitmap), includeImages)
    .catch((e) => {
      job.state.error = e?.message || String(e);
      job.state.done = false;
      // failed crawls don't poison the cache — but only evict OUR entry
      // (a newer job may have replaced it after a TTL expiry)
      if (crawlCache.get(key)?.job === job) crawlCache.delete(key);
      job.emit("error", { message: job.state.error });
      return null;
    });
  return job;
}

// ---------------------------------------------------------------------------
// The crawl itself
// ---------------------------------------------------------------------------

async function runCrawl(job, n, includeImages) {
  const t0 = Date.now();
  const deadline = t0 + CAPS.TIMEOUT_MS;
  const timedOut = () => Date.now() > deadline;

  const pool = createPool(CAPS.CONCURRENCY);
  const nodes = new Map();          // id -> node
  const edges = [];
  const edgeKeys = new Set();
  const scannedSats = new Set();
  const truncated = [];
  const counters = { requests: 0, errors: 0 };
  let maxNodesHit = false;
  let depthCapHit = false;

  const retryOpts = { onFail: () => counters.errors++, deadline };
  const ordJson = (path) => pool.run(() => withRetry(() => { counters.requests++; return fetchOrd(path); }, retryOpts));
  const ordText = (path) => pool.run(() => withRetry(() => { counters.requests++; return fetchOrd(path, { as: "text" }); }, retryOpts));
  const ordBin = (path) => pool.run(() => withRetry(() => { counters.requests++; return fetchOrdBinary(path); }, retryOpts));

  let lastEmit = 0;
  const progress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 400) return;
    lastEmit = now;
    job.emit("progress", job.state);
  };
  const setPhase = (phase) => { job.state.phase = phase; progress(true); };

  function addNode(id, extra) {
    let node = nodes.get(id);
    if (node) return node;
    node = {
      id, number: null, sat: null, content_type: null, content_length: null,
      address: null, timestamp: null, height: null, delegate: null,
      depth: extra.depth ?? null, kind: extra.kind, bitmap: extra.bitmap ?? null,
      text: null, textTruncated: null, image: null,
      childCount: 0, childrenTruncated: false, parents: null,
    };
    nodes.set(id, node);
    job.state.discovered = nodes.size;
    return node;
  }
  function fillMeta(node, meta) {
    if (!meta) return;
    node.number = meta.number ?? node.number;
    node.sat = meta.sat ?? node.sat;
    node.content_type = meta.content_type ?? node.content_type;
    node.content_length = meta.content_length ?? node.content_length;
    node.address = meta.address ?? node.address;
    node.timestamp = meta.timestamp ?? node.timestamp;
    node.height = meta.height ?? node.height;
    node.delegate = meta.delegate ?? node.delegate; // /content/<id> serves the delegate's content
    if (Array.isArray(meta.parents)) node.parents = meta.parents; // saves /r/parents calls
  }
  function addEdge(from, to, type) {
    const k = `${from}|${to}|${type}`;
    if (edgeKeys.has(k)) return;
    edgeKeys.add(k);
    edges.push({ from, to, type });
  }

  // --- Phase 0: resolve the canonical bitmap inscription --------------------
  setPhase("resolve");
  // retried: one transient gateway error must not fail the whole crawl
  const sat = await withRetry(() => getBitmapSat(n), { tries: 3, deadline }); // out-of-range is pre-validated by the route
  if (!sat) throw new Error(`bitmap ${n} not found in the on-chain index (0-${MAX_INDEXED_BITMAP}) — or the gateway is unreachable, try again`);
  const rootId = await withRetry(() => getBitmapInscriptionId(n), { tries: 3, deadline });
  if (!rootId) throw new Error("could not resolve the canonical inscription from the ord gateway — try again shortly");
  const rootMeta = await ordJson(`/r/inscription/${rootId}`);
  if (!rootMeta) throw new Error("could not fetch the root inscription from the ord gateway — try again shortly");
  const rootNode = addNode(rootId, { kind: "root", depth: 0, bitmap: n });
  fillMeta(rootNode, rootMeta);
  job.state.fetched++;

  // --- Phase 1: downward BFS — children at all depths -----------------------
  setPhase("children");
  async function crawlChildrenOf(id, depth) {
    const childIds = [];
    for (let page = 0; page < CAPS.CHILD_PAGE_CAP; page++) {
      if (timedOut()) break;
      const j = await ordJson(`/r/children/${id}/${page}`);
      if (!j) break;
      childIds.push(...(j.ids || []));
      if (!j.more) break;
      if (page === CAPS.CHILD_PAGE_CAP - 1) {
        nodes.get(id).childrenTruncated = true;
        truncated.push(`children of ${short(id)} listed only up to ~${childIds.length}`);
      }
    }
    nodes.get(id).childCount = childIds.length;
    const fresh = [];
    for (const cid of childIds) {
      addEdge(id, cid, "child");
      if (nodes.has(cid)) continue;
      if (nodes.size >= CAPS.MAX_NODES) { maxNodesHit = true; break; }
      fresh.push(addNode(cid, { kind: "child", depth: depth + 1 }));
    }
    await Promise.all(fresh.map(async (node) => {
      const meta = await ordJson(`/r/inscription/${node.id}`);
      fillMeta(node, meta);
      job.state.fetched++;
      progress();
    }));
    if (depth + 1 >= CAPS.MAX_DEPTH && fresh.length) depthCapHit = true;
    return depth + 1 < CAPS.MAX_DEPTH ? fresh.map((c) => ({ id: c.id, depth: depth + 1 })) : [];
  }
  let frontier = [{ id: rootId, depth: 0 }];
  while (frontier.length && !timedOut() && !maxNodesHit) {
    const results = await Promise.all(frontier.map((f) => crawlChildrenOf(f.id, f.depth)));
    frontier = results.flat();
  }
  if (depthCapHit) truncated.push(`depth cap ${CAPS.MAX_DEPTH} reached — deeper descendants not crawled`);

  // --- Phase 2: parents of every family member ------------------------------
  // /r/inscription already returns the parents list for most inscriptions, so
  // extra /r/parents pages are only fetched when that list is suspiciously
  // full (paged). New parents are identified and climbed to their district
  // root; neighbor districts are NOT recursed into (a co-parent district can
  // have thousands of children unrelated to this bitmap).
  setPhase("parents");
  const familyIds = [...nodes.keys()];
  await Promise.all(familyIds.map(async (id) => {
    if (timedOut()) return;
    const node = nodes.get(id);
    let parentIds = Array.isArray(node.parents) ? [...node.parents] : null;
    if (parentIds === null || parentIds.length >= 100) {
      parentIds = [];
      for (let page = 0; page < CAPS.PARENT_PAGE_CAP; page++) {
        const j = await ordJson(`/r/parents/${id}/${page}`);
        if (!j) break;
        parentIds.push(...(j.ids || []));
        if (!j.more) break;
      }
    }
    for (const pid of parentIds) {
      if (timedOut()) return;
      addEdge(pid, id, "child");
      if (nodes.has(pid)) continue;
      if (nodes.size >= CAPS.MAX_NODES) { maxNodesHit = true; return; }
      const pnode = addNode(pid, { kind: "parent", depth: null });
      const meta = await ordJson(`/r/inscription/${pid}`);
      fillMeta(pnode, meta);
      job.state.fetched++;
      progress();
      // climb to the top of the co-parent's own family tree
      const top = await pool.run(() => topAncestor(pid).catch(() => pid));
      if (timedOut()) return;
      const info = await pool.run(() => isCanonicalBitmapParent(top).catch(() => null));
      if (info) {
        if (!nodes.has(top)) {
          if (nodes.size >= CAPS.MAX_NODES) { maxNodesHit = true; return; }
          const tnode = addNode(top, { kind: "neighbor-bitmap", depth: null, bitmap: info.bitmap });
          const tmeta = await ordJson(`/r/inscription/${top}`);
          fillMeta(tnode, tmeta);
          job.state.fetched++;
          const cj = await ordJson(`/r/children/${top}/0`);
          tnode.childCount = (cj?.ids || []).length;
          tnode.childrenTruncated = !!cj?.more;
          if (top !== pid) addEdge(top, pid, "ancestor");
        } else {
          const t = nodes.get(top);
          if (t.kind === "parent") { t.kind = "neighbor-bitmap"; t.bitmap = info.bitmap; }
          if (top !== pid) addEdge(top, pid, "ancestor");
        }
      }
    }
  }));

  // --- Phase 3: reinscriptions on every discovered sat ----------------------
  setPhase("reinscriptions");
  const scanTargets = [...nodes.values()].filter((x) => x.sat != null).slice(0, CAPS.SAT_SCAN_LIMIT);
  if ([...nodes.values()].filter((x) => x.sat != null).length > scanTargets.length) {
    truncated.push(`reinscription scans limited to the first ${CAPS.SAT_SCAN_LIMIT} inscriptions (BFS order)`);
  }
  await Promise.all(scanTargets.map(async (node) => {
    if (timedOut()) return;
    if (scannedSats.has(node.sat)) return;
    scannedSats.add(node.sat);
    const ids = [];
    let saw = false;
    for (let page = 0; page < CAPS.SAT_PAGE_CAP; page++) {
      const j = await ordJson(`/r/sat/${node.sat}/${page}`);
      if (!j) break;
      saw = true;
      ids.push(...(j.ids || []));
      if (!j.more) break;
      if (page === CAPS.SAT_PAGE_CAP - 1) truncated.push(`reinscriptions on sat of ${short(node.id)} listed only partially`);
    }
    if (!saw) return;
    // pages are oldest-first and capped — /at/-1 is always the true newest
    const tip = await ordJson(`/r/sat/${node.sat}/at/-1`);
    if (tip?.id && !ids.includes(tip.id)) ids.push(tip.id);
    for (const rid of ids) {
      if (rid === node.id || nodes.has(rid)) continue;
      if (nodes.size >= CAPS.MAX_NODES) { maxNodesHit = true; break; }
      addEdge(node.id, rid, "reinscription");
      const rnode = addNode(rid, { kind: "reinscription", depth: node.depth });
      const meta = await ordJson(`/r/inscription/${rid}`);
      fillMeta(rnode, meta);
      job.state.fetched++;
      progress();
    }
  }));

  // --- Phase 4: content -----------------------------------------------------
  setPhase("content");
  let textTotal = 0;
  const textNodes = [...nodes.values()].filter((x) => x.content_type && TEXTY_RE.test(x.content_type));
  await Promise.all(textNodes.map(async (node) => {
    if (timedOut()) return;
    if (node.content_length != null && node.content_length > CAPS.TEXT_ITEM_CAP) { node.textTruncated = "too-big"; return; }
    if (textTotal > CAPS.TEXT_TOTAL_CAP) { node.textTruncated = "total-cap"; return; }
    const t = await ordText(`/content/${node.id}`);
    if (t == null) { node.textTruncated = "fetch-failed"; return; }
    // re-check AFTER the await — at map() time every task still sees textTotal=0
    if (textTotal > CAPS.TEXT_TOTAL_CAP) { node.textTruncated = "total-cap"; return; }
    node.text = t.length > CAPS.TEXT_ITEM_CAP ? t.slice(0, CAPS.TEXT_ITEM_CAP) : t;
    if (t.length > CAPS.TEXT_ITEM_CAP) node.textTruncated = "clipped";
    textTotal += node.text.length;
    job.state.contentFetched++;
    progress();
  }));
  if (textNodes.some((x) => x.textTruncated === "total-cap")) {
    truncated.push(`total text-content cap ${CAPS.TEXT_TOTAL_CAP} bytes reached — some content omitted`);
  }

  if (includeImages) {
    setPhase("images");
    const imgNodes = [...nodes.values()].filter((x) =>
      x.content_type && CLAUDE_IMG_RE.test(x.content_type.split(";")[0].trim()) &&
      (x.content_length == null || x.content_length <= CAPS.IMAGE_MAX_BYTES));
    // most interesting first: reinscriptions on the root's own sat (profile
    // image convention), then any reinscription, then the rest smallest-first
    const rank = (x) => (x.kind === "reinscription" && x.sat === rootNode.sat) ? 0 : (x.kind === "reinscription" ? 1 : 2);
    imgNodes.sort((a, b) => rank(a) - rank(b) || (a.content_length || 0) - (b.content_length || 0));
    if (imgNodes.length > CAPS.IMAGE_CAP) {
      truncated.push(`only ${CAPS.IMAGE_CAP} of ${imgNodes.length} images passed to the assistant`);
    }
    await Promise.all(imgNodes.slice(0, CAPS.IMAGE_CAP).map(async (node) => {
      if (timedOut()) return;
      const bin = await ordBin(`/content/${node.id}`);
      if (!bin || bin.buf.length > CAPS.IMAGE_MAX_BYTES) return;
      const mt = bin.contentType || node.content_type.split(";")[0].trim().toLowerCase();
      if (!CLAUDE_IMG_RE.test(mt)) return;
      node.image = { media_type: mt, base64: bin.buf.toString("base64") };
      job.state.images++;
      progress();
    }));
  }

  // --- Finalize -------------------------------------------------------------
  if (maxNodesHit) truncated.push(`node cap ${CAPS.MAX_NODES} reached — the graph is incomplete`);
  if (timedOut()) truncated.push(`crawl hit the ${Math.round(CAPS.TIMEOUT_MS / 1000)}s time limit — partial data`);

  const all = [...nodes.values()];
  const stats = {
    nodes: all.length,
    children: all.filter((x) => x.kind === "child").length,
    reinscriptions: all.filter((x) => x.kind === "reinscription").length,
    parents: all.filter((x) => x.kind === "parent").length,
    neighbors: all.filter((x) => x.kind === "neighbor-bitmap").length,
    withText: all.filter((x) => x.text != null).length,
    withImages: all.filter((x) => x.image != null).length,
    maxDepth: Math.max(0, ...all.map((x) => x.depth ?? 0)),
    requests: counters.requests,
    errors: counters.errors,
    ms: Date.now() - t0,
    truncated,
  };
  // node.parents was only an optimization vector — drop it from the output
  for (const x of all) delete x.parents;

  job.graph = {
    bitmap: n, rootId, includeImages,
    crawledAt: new Date(t0).toISOString(),
    nodes: all, edges, stats,
  };
  job.state.done = true;
  setPhase("done");
  job.emit("ready", { stats, cached: false });
  console.log(`crawl bitmap=${n} images=${includeImages ? 1 : 0} nodes=${stats.nodes} reqs=${stats.requests} errs=${stats.errors} ${stats.ms}ms`);
  return job.graph;
}
