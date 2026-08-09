// PURE layout for buying a listed parcel. No DOM, no network, no wallet — the
// browser builds the real transaction from this, and the tests check it.
//
// The seller signed with SIGHASH_SINGLE | ANYONECANPAY. That signature covers
// their own input, and the output that sits at THE SAME INDEX as that input in
// the finished transaction. So the whole safety of this file is one rule:
//
//     the seller's payment output must be at the same index as their input
//
// If those drift apart the signature verifies against the wrong output. Bitcoin
// will happily relay it, the buyer pays, and the parcel or the money lands
// somewhere nobody intended. Hence the fixed shape below, and hence the dummy
// UTXOs — they exist purely to hold the indexes still:
//
//   in  0  buyer padding          out 0  padding, recombined, back to the buyer
//   in  1  buyer padding          out 1  the parcel, to the buyer
//   in  2  THE SELLER'S PARCEL    out 2  the price, to the seller   <- indexes match
//   in  3+ buyer funding          out 3  change, to the buyer

export const SELLER_INDEX = 2;   // fixed: two padding inputs come first
export const DUST = 546;
export const MIN_DUMMY = 550;    // padding must survive being spent again
export const MAX_DUMMY = 1000;   // and must not be an inscription-sized output

class BuyError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
const bad = (m, code) => { throw new BuyError(m, code); };

const utxoOk = (u, what) => {
  if (!u || !/^[0-9a-f]{64}$/.test(String(u.txid || ""))) bad(`${what}: missing a transaction id`, "utxo");
  if (!Number.isInteger(u.vout) || u.vout < 0) bad(`${what}: bad output index`, "utxo");
  if (!Number.isInteger(u.value) || u.value <= 0) bad(`${what}: no value`, "utxo");
};

// rough but honest: taproot inputs ~58 vB, outputs ~43 vB, 11 vB overhead
export const estimateVsize = (nIn, nOut) => Math.ceil(11 + nIn * 58 + nOut * 43);

/**
 * @param {object} o
 * @param {object} o.listing   {utxo:{txid,vout,value}, priceSats, sellerScriptAddress}
 * @param {object} o.buyer     {ordAddress, payAddress}
 * @param {object[]} o.dummies exactly two small padding UTXOs the buyer owns
 * @param {object[]} o.funding buyer UTXOs to pay with (confirmed)
 * @param {number} o.feeRate   sat/vB
 */
export function planPurchase(o) {
  const { listing, buyer, feeRate } = o;
  const dummies = o.dummies || [];
  const funding = o.funding || [];

  if (!buyer?.ordAddress || !buyer?.payAddress) bad("connect your wallet first", "wallet");
  if (!listing?.utxo) bad("that listing has no parcel attached", "listing");
  utxoOk(listing.utxo, "the parcel");
  const price = Math.round(Number(listing.priceSats));
  if (!Number.isInteger(price) || price < 1000) bad("that listing has no sensible price", "price");
  if (!listing.sellerScriptAddress) bad("that listing has no payout address", "listing");
  const rate = Math.max(1, Math.min(500, Number(feeRate) || 6));

  // --- padding ---------------------------------------------------------------
  if (dummies.length !== 2) {
    bad("you need two small padding outputs to buy — the app can make them for you", "need-dummies");
  }
  dummies.forEach((d, i) => {
    utxoOk(d, `padding ${i + 1}`);
    if (d.value < MIN_DUMMY || d.value > MAX_DUMMY) {
      bad(`padding ${i + 1} must hold between ${MIN_DUMMY} and ${MAX_DUMMY} sats, not ${d.value}`, "bad-dummy");
    }
  });
  const seen = new Set();
  for (const u of [...dummies, listing.utxo, ...funding]) {
    const k = `${u.txid}:${u.vout}`;
    if (seen.has(k)) bad("the same coin cannot be spent twice in one transaction", "dup-input");
    seen.add(k);
  }

  // --- inputs, in the order the signature depends on --------------------------
  const ins = [
    { ...dummies[0], role: "padding", owner: "buyer" },
    { ...dummies[1], role: "padding", owner: "buyer" },
    { ...listing.utxo, role: "parcel", owner: "seller" },
  ];
  if (ins[SELLER_INDEX].owner !== "seller") bad("internal: the seller's input moved", "bug-index");

  const outs = [
    { to: buyer.ordAddress, value: dummies[0].value + dummies[1].value, role: "padding" },
    { to: buyer.ordAddress, value: listing.utxo.value, role: "parcel" },
    { to: listing.sellerScriptAddress, value: price, role: "payment" },
  ];

  // --- funding ---------------------------------------------------------------
  // The padding comes straight back out and the parcel's own sats travel from
  // the seller's input to the buyer's parcel output, so neither needs paying
  // for. The buyer funds exactly the price plus the fee.
  let have = 0;
  const chosen = [];
  for (const u of [...funding].sort((a, b) => b.value - a.value)) {
    utxoOk(u, "one of your coins");
    chosen.push(u); have += u.value;
    if (have >= price + estimateVsize(3 + chosen.length, 4) * rate + DUST) break;
  }
  const estFee = estimateVsize(3 + chosen.length, 4) * rate;
  const owed = price + estFee;
  if (have < owed) {
    bad(`not enough confirmed bitcoin — this costs about ${owed.toLocaleString("en-US")} sats and you have ${have.toLocaleString("en-US")}`, "short");
  }
  for (const u of chosen) ins.push({ ...u, role: "funding", owner: "buyer" });

  // change below the dust floor is not worth an output; it becomes fee instead
  const change = have - owed;
  if (change >= DUST) outs.push({ to: buyer.payAddress, value: change, role: "change" });

  // --- the invariants that keep the parcel and the money where they belong ----
  const sellerIn = ins.findIndex((i) => i.owner === "seller");
  const payOut = outs.findIndex((x) => x.role === "payment");
  if (sellerIn !== SELLER_INDEX) bad("internal: the seller's input is not where the signature expects", "bug-index");
  if (payOut !== sellerIn) {
    bad(`internal: the seller signs output ${sellerIn} but the payment sits at ${payOut}`, "bug-index");
  }
  if (outs[payOut].value !== price) bad("internal: the payment is not the asking price", "bug-price");
  if (outs[1].value !== listing.utxo.value) bad("internal: the parcel output must carry its own sats", "bug-parcel");
  if (outs.some((x) => x.value < DUST && x.role !== "padding")) bad("internal: an output is below the dust floor", "bug-dust");

  const inTotal = ins.reduce((s, i) => s + i.value, 0);
  const outTotal = outs.reduce((s, x) => s + x.value, 0);
  // whatever is left over IS the fee — including a dropped change output
  const fee = inTotal - outTotal;
  if (fee < estFee) bad("internal: the fee came out below the estimate", "bug-balance");
  if (fee <= 0) bad("internal: nothing left for the fee", "bug-balance");

  return {
    ins, outs, fee, price, change: change >= DUST ? change : 0,
    sellerInputIndex: sellerIn,
    // the buyer signs everything except the seller's input
    buyerInputIndexes: ins.map((i, k) => (i.owner === "buyer" ? k : -1)).filter((k) => k >= 0),
    // the parcel's own sats come from the seller's input, so the buyer pays
    // the price and the fee, and receives that postage with the parcel
    total: price + fee,
  };
}

// Buyers without padding need two small outputs first. This is the shape of
// that preparation transaction — plain, and nothing to do with the seller.
export function planDummies({ payAddress, funding = [], feeRate = 6, size = 600 }) {
  if (!payAddress) bad("connect your wallet first", "wallet");
  const rate = Math.max(1, Math.min(500, Number(feeRate) || 6));
  if (size < MIN_DUMMY || size > MAX_DUMMY) bad(`padding must be between ${MIN_DUMMY} and ${MAX_DUMMY} sats`, "bad-dummy");
  let have = 0;
  const chosen = [];
  for (const u of [...funding].sort((a, b) => b.value - a.value)) {
    utxoOk(u, "one of your coins");
    chosen.push(u); have += u.value;
    if (have >= size * 2 + estimateVsize(chosen.length, 3) * rate + DUST) break;
  }
  const fee = estimateVsize(chosen.length, 3) * rate;
  if (have < size * 2 + fee) bad("not enough confirmed bitcoin to make the padding outputs", "short");
  const outs = [
    { to: payAddress, value: size, role: "padding" },
    { to: payAddress, value: size, role: "padding" },
  ];
  const change = have - size * 2 - fee;
  if (change >= DUST) outs.push({ to: payAddress, value: change, role: "change" });
  return { ins: chosen, outs, fee };
}
