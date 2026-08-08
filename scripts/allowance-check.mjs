// Shows the real free-question allowance for a wallet, straight from chain
// data: 1 base + 1 per PathScriber + 1 per 114588 parcel.
// Usage: node scripts/allowance-check.mjs <address> [more addresses…]
import { getWalletScan, freeAllowance } from "../src/wallet.js";

const addrs = process.argv.slice(2);
if (!addrs.length) { console.error("pass at least one address"); process.exit(1); }

for (const a of addrs) {
  try {
    const s = await getWalletScan(a);
    const allowance = await freeAllowance(a);
    console.log(`${a.slice(0, 10)}…${a.slice(-6)}  bitmaps:${s.bitmaps.length}  pathscribers:${s.pathscribers.length}  parcels:${s.parcels.length}  ->  ${allowance} free question${allowance === 1 ? "" : "s"}/day`);
  } catch (e) {
    console.log(`${a}: scan failed — ${e.message}`);
  }
}
