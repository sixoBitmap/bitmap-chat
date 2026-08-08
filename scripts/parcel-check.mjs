// Verifies THE PARCEL RULE against live on-chain data:
//   parcel = child of 114588.bitmap + content "x.114588.bitmap" + x < block
//   114588's tx count (100) + first claim per x wins.
// The "bless" child (a456b3…b35i0) must NOT count, even though it IS a child.
// Run:  node scripts/parcel-check.mjs
import { gateData, getWalletScan } from "../src/wallet.js";

const BLESS = "a456b30ae66ebe8a966d47d94abcf86082c81e80be73cba0a8f0174362f32b35i0";
const OWNER = "bc1p50dw6g5kgf4a7d92cgaqe46k7hf2lcqm9dzfqxpdeflprcmzg33q227fhj"; // holds the bless child + PathScriber mint #1

const g = await gateData();
console.log(`block txCount: ${g.txCount} | children: ${g.childIds.size} | canonical parcels: ${g.parcelById.size}`);
console.log("parcels found:", [...g.parcelById.values()].map((p) => p.text).sort((a, b) => parseInt(a) - parseInt(b)).join(", ") || "(none)");

if (!g.childIds.has(BLESS)) console.log("note: 'bless' inscription is not currently in the child list");
else console.log("✓ 'bless' IS a child of 114588.bitmap …");
if (g.parcelById.has(BLESS)) { console.error("✗ FAIL: the 'bless' child counted as a parcel"); process.exit(1); }
console.log("✓ … and is correctly NOT a canonical parcel");

const scan = await getWalletScan(OWNER);
console.log("owner wallet:", JSON.stringify({
  bitmaps: scan.bitmaps.map((b) => b.n),
  parcels: scan.parcels.map((p) => p.text),
  pathscribers: scan.pathscribers.length,
  unlocked: scan.unlocked,
}));
if (scan.parcels.some((p) => p.id === BLESS)) { console.error("✗ FAIL: 'bless' listed in wallet parcels"); process.exit(1); }
console.log("✓ wallet scan does not list 'bless' as a parcel");
