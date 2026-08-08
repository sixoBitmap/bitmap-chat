// Dev helper: mint a wallet session token using the public BIP-322 test key.
// Usage: node scripts/mint-token.mjs [outfile]
import { Signer } from "bip322-js";
import fs from "node:fs";
const BASE = process.env.BASE || "http://localhost:3100";
const WIF = "L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k";
const ADDR = "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l";
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const ch = await (await post("/api/auth/challenge", { address: ADDR })).json();
const raw = Signer.sign(WIF, ADDR, ch.message);
const out = await (await post("/api/auth/verify", { nonce: ch.nonce, signature: Buffer.isBuffer(raw) ? raw.toString("base64") : String(raw) })).json();
if (!out.token) { console.error("mint failed:", out); process.exit(1); }
const file = process.argv[2];
if (file) fs.writeFileSync(file, out.token);
console.log("token minted for", out.address, file ? `-> ${file}` : "");
if (!file) console.log(out.token);
