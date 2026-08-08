// BIP-322 wallet sign-in (btcmail pattern): the wallet PROVES it controls the
// ordinals address by signing a one-time challenge; the server verifies the
// signature locally (bip322-js — no third party for the auth math) and issues
// a JWT. Every gated route then trusts ONLY the token's address — a client can
// no longer claim an address it doesn't own.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { Verifier } from "bip322-js";

const SESSION_TTL = process.env.SESSION_TTL || "24h";
const NONCE_TTL_MS = 10 * 60 * 1000;

// Session secret: env var wins; otherwise generate ONCE and persist to
// .jwt-secret so wallet sign-ins survive server restarts (a per-boot random
// secret silently invalidated every session on restart).
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".jwt-secret");
  try {
    const s = fs.readFileSync(file, "utf8").trim();
    if (s.length >= 32) return s;
  } catch { /* first boot */ }
  const s = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(file, s, { mode: 0o600 });
    console.log("generated .jwt-secret — wallet sessions now survive restarts (set JWT_SECRET in production)");
  } catch (e) {
    console.warn("could not persist .jwt-secret (sessions reset on restart):", e?.message);
  }
  return s;
}
const JWT_SECRET = loadSecret();

const nonces = new Map(); // nonce -> { address, message, at }
setInterval(() => {
  const cut = Date.now() - NONCE_TTL_MS;
  for (const [k, v] of nonces) if (v.at < cut) nonces.delete(k);
}, 5 * 60 * 1000).unref();

export function makeChallenge(address) {
  if (nonces.size > 5000) nonces.clear(); // abuse backstop
  const nonce = crypto.randomBytes(16).toString("hex");
  const message = `Sign in to Bitmap Chat\naddress: ${address}\nnonce: ${nonce}`;
  nonces.set(nonce, { address, message, at: Date.now() });
  return { nonce, message };
}

// Single-use: the nonce is deleted whether or not verification succeeds.
export function verifyChallenge(nonce, signatureB64) {
  const row = nonces.get(String(nonce || ""));
  nonces.delete(String(nonce || ""));
  if (!row) return { error: "unknown nonce — request a new challenge" };
  if (Date.now() - row.at > NONCE_TTL_MS) return { error: "challenge expired — try again" };
  let ok = false;
  try {
    ok = Verifier.verifySignature(row.address, row.message, String(signatureB64 || "")) === true;
  } catch {
    ok = false; // unsupported address type / malformed signature
  }
  if (!ok) return { error: "signature does not match the address" };
  const token = jwt.sign({ addr: row.address }, JWT_SECRET, { expiresIn: SESSION_TTL });
  return { token, address: row.address };
}

// Express middleware: req.walletAddr = the PROVEN address from a valid Bearer
// token, or null. req.walletAuthFailed distinguishes "presented a token that
// is expired/invalid" from "never presented one" — the UI needs to know the
// difference to reset a stuck session.
export function walletAuth(req, _res, next) {
  req.walletAddr = null;
  req.walletAuthFailed = false;
  const m = /^Bearer (.+)$/.exec(req.get("authorization") || "");
  if (m) {
    try { req.walletAddr = jwt.verify(m[1], JWT_SECRET).addr || null; } catch { req.walletAuthFailed = true; }
  }
  next();
}
