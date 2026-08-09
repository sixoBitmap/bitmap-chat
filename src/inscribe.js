// Server help for the in-page inscribe tool.
//
// The page builds its own commit/reveal transactions, but its CSP only lets it
// talk to this origin — deliberately, so no third-party host can be reached
// from a page that handles a wallet. These three routes are the whole bridge:
//
//   GET  /api/ord/r/...     read the chain (through oci.js: one gateway list,
//                           browser UA, 429 cooldown, retries)
//   GET  /api/btc/utxos     coins at the payment address, to fund the commit
//   POST /api/btc/broadcast push a signed transaction
//
// The last two need a proven wallet and are rate-limited hard: broadcast is an
// open transaction relay if you leave it unguarded.

import rateLimit from "express-rate-limit";
import { fetchOrd } from "./oci.js";

const MEMPOOL = (process.env.MEMPOOL_API || "https://mempool.space").replace(/\/$/, "");
const BACKUP = (process.env.BROADCAST_BACKUP || "https://blockstream.info").replace(/\/$/, "");
const HEADERS = { "User-Agent": "bitmap-ai-chat", Accept: "application/json" };

// Only these recursive reads, and nothing that could be turned into an open proxy.
const ORD_PATHS = /^\/(inscription|parents|children|sat|blockinfo|blockheight)\//;

// A satpoint that is a few seconds stale builds a transaction that can never
// confirm, so inscription lookups are never cached. The rest barely change.
const cache = new Map(); // path -> { at, body }
const CACHE_MS = 15_000;

export function mountInscribe(app, { requireWallet }) {
  const readLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
  const utxoLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
  const castLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

  // --- read the chain --------------------------------------------------------
  app.get("/api/ord/r/*", readLimiter, async (req, res) => {
    const path = "/" + req.params[0];
    if (!ORD_PATHS.test(path) || path.includes("..")) {
      return res.status(400).json({ error: "not a readable path" });
    }
    const fresh = path.startsWith("/inscription/"); // satpoints must never be stale
    const hit = !fresh && cache.get(path);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.body);
    try {
      const body = await fetchOrd(`/r${path}`);
      if (!fresh) {
        cache.set(path, { at: Date.now(), body });
        if (cache.size > 500) cache.delete(cache.keys().next().value);
      }
      res.json(body);
    } catch (e) {
      const code = e?.status === 404 || e?.notFound ? 404 : 502;
      res.status(code).json({ error: code === 404 ? "not found on chain yet" : "the ord gateway is not answering — try again in a moment" });
    }
  });

  // --- coins to fund the commit ---------------------------------------------
  app.get("/api/btc/utxos", utxoLimiter, async (req, res) => {
    if (requireWallet(req, res)) return;
    const address = String(req.query.address || "").trim();
    if (!/^(bc1[a-z0-9]{20,90}|[13][a-zA-Z0-9]{25,40})$/.test(address)) {
      return res.status(400).json({ error: "that is not a Bitcoin address" });
    }
    try {
      const r = await fetch(`${MEMPOOL}/api/address/${address}/utxo`, { headers: HEADERS });
      if (!r.ok) throw new Error(String(r.status));
      const utxos = await r.json();
      res.json({
        address,
        utxos: (Array.isArray(utxos) ? utxos : []).map((u) => ({
          txid: u.txid, vout: u.vout, value: u.value, confirmed: !!u.status?.confirmed,
        })),
      });
    } catch {
      res.status(502).json({ error: "could not read that address's coins — try again in a moment" });
    }
  });

  // --- push a signed transaction --------------------------------------------
  app.post("/api/btc/broadcast", castLimiter, async (req, res) => {
    if (requireWallet(req, res)) return;
    const hex = String(req.body?.hex || "").trim().toLowerCase();
    if (!/^[0-9a-f]{200,}$/.test(hex) || hex.length > 800_000) {
      return res.status(400).json({ error: "that is not a signed transaction" });
    }
    const tryHost = async (host, path) => {
      const r = await fetch(host + path, { method: "POST", headers: { "Content-Type": "text/plain" }, body: hex });
      const text = (await r.text()).trim();
      if (!r.ok) throw new Error(text || `HTTP ${r.status}`);
      return text;
    };
    try {
      const txid = await tryHost(MEMPOOL, "/api/tx");
      console.log(`broadcast ${txid} for ${req.walletAddr}`);
      res.json({ txid });
    } catch (first) {
      try {
        const txid = await tryHost(BACKUP, "/api/tx");
        console.log(`broadcast ${txid} for ${req.walletAddr} (backup relay)`);
        res.json({ txid });
      } catch (second) {
        // the node's own words are the only useful diagnosis here
        console.error("broadcast failed:", first?.message, "|", second?.message);
        res.status(502).json({ error: `the network refused it: ${String(first?.message || second?.message).slice(0, 300)}` });
      }
    }
  });
}
