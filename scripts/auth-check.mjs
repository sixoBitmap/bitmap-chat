// End-to-end BIP-322 sign-in check against a RUNNING server (default :3100).
// Run:  node scripts/auth-check.mjs
// Uses the public BIP-322 test-vector key — an empty wallet, so gated crawls
// must still be refused with the "doesn't hold" message after sign-in.
import assert from "node:assert";
import { Signer } from "bip322-js";

const BASE = process.env.BASE || "http://localhost:3100";
const WIF = "L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k"; // public BIP-322 test vector
const ADDR = "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l";

const post = (p, body, headers = {}) =>
  fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });

// 1) challenge
const ch = await (await post("/api/auth/challenge", { address: ADDR })).json();
assert.ok(ch.nonce && ch.message?.includes(ADDR), "challenge issued");

// 2) a wrong signature must be rejected (and burn that nonce)
const bad = await post("/api/auth/verify", {
  nonce: ch.nonce,
  signature: "AkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=",
});
assert.equal(bad.status, 401, "wrong signature must be 401");

// 3) fresh challenge + REAL signature -> session token
const ch2 = await (await post("/api/auth/challenge", { address: ADDR })).json();
const raw = Signer.sign(WIF, ADDR, ch2.message);
const signature = Buffer.isBuffer(raw) ? raw.toString("base64") : String(raw);
const ver = await post("/api/auth/verify", { nonce: ch2.nonce, signature });
const out = await ver.json();
assert.equal(ver.status, 200, "verify status: " + JSON.stringify(out));
assert.ok(out.token && out.address === ADDR, "token issued");

// 4) nonce is single-use — replaying the same nonce+signature must fail
const replay = await post("/api/auth/verify", { nonce: ch2.nonce, signature });
assert.equal(replay.status, 401, "nonce replay must be 401");

// 5) signed-in wallet scan works (empty wallet — no bitmaps, no PathScribers)
const authH = { Authorization: `Bearer ${out.token}` };
const scanRes = await post("/api/wallet/scan", {}, authH);
const scan = await scanRes.json();
assert.equal(scanRes.status, 200, "scan: " + JSON.stringify(scan));
assert.ok(Array.isArray(scan.bitmaps) && Array.isArray(scan.pathscribers), "scan shape");

// 6) gate: no token -> "sign in"; with token but empty wallet -> "doesn't hold"
const noTok = await fetch(`${BASE}/api/crawl/0`);
assert.equal(noTok.status, 403, "no token must be 403");
const noTokBody = await noTok.json();
assert.match(noTokBody.error, /sign in/i);
const withTok = await fetch(`${BASE}/api/crawl/0`, { headers: authH });
const withTokBody = await withTok.json();
assert.equal(withTok.status, 403, "empty wallet must be 403");
assert.match(withTokBody.error, /doesn't hold/);

console.log("✓ BIP-322 auth chain verified:", {
  address: out.address,
  bitmaps: scan.bitmaps.length,
  pathscribers: scan.pathscribers.length,
  parcels: scan.parcels.length,
  unlocked: scan.unlocked,
});
