// Seller side of the marketplace.
//
// A listing is one signed input and one signed output: "whoever spends my
// parcel must pay me this much". The signature uses
// SIGHASH_SINGLE | ANYONECANPAY (0x83), which commits to that input and the
// output at the SAME INDEX, and to nothing else — so a buyer can later add
// their own inputs and outputs around it without breaking it.
//
// That sighash is the whole mechanism, and not every wallet will produce it.
// So after signing we read the sighash byte back out of the signature: a
// taproot signature is 64 bytes for the default type and 65 with the type
// appended. If the wallet quietly signed with SIGHASH_ALL, the offer would be
// unspendable by anyone and we refuse to store it rather than list a lie.

import { inscLibs, hex2u8, u82b64, b642u8, xonly } from "./inscribe-tx.js";

export const SIGHASH_SINGLE_ANYONECANPAY = 0x83;

/**
 * Build and sign the offer.
 * @returns {{psbt:string, priceSats:number}} base64 PSBT carrying the signature
 */
export async function buildListing({ utxo, ordAddress, ordPubkey, priceSats, payTo, signPsbt }) {
  const { btc } = await inscLibs();
  const NET = btc.NETWORK;
  const price = Math.round(Number(priceSats));
  if (!Number.isInteger(price) || price < 1000) throw new Error("pick a price of at least 1000 sats");

  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  const script = btc.OutScript.encode(btc.Address(NET).decode(ordAddress));
  tx.addInput({
    txid: utxo.txid, index: utxo.vout,
    witnessUtxo: { script, amount: BigInt(utxo.value) },
    ...(ordPubkey ? { tapInternalKey: xonly(ordPubkey) } : {}),
    // the wallet is asked for this type by way of the PSBT field
    sighashType: SIGHASH_SINGLE_ANYONECANPAY,
  });
  // output 0 pairs with input 0 under SIGHASH_SINGLE: this is what must be paid
  tx.addOutputAddress(payTo || ordAddress, BigInt(price), NET);

  const signed = btc.Transaction.fromPSBT(await signPsbt(tx.toPSBT(), { [ordAddress]: [0] }));
  assertSighash(signed);
  return { psbt: u82b64(signed.toPSBT()), priceSats: price };
}

/**
 * Read the sighash flag back out of the signature the wallet produced.
 * Throws with a plain explanation when the wallet ignored the request.
 */
export function assertSighash(signedTx) {
  const input = signedTx.getInput(0);
  const sig = input?.tapKeySig || input?.tapScriptSig?.[0]?.[1] ||
    (input?.partialSig && input.partialSig[0] && input.partialSig[0][1]);
  if (!sig) throw new Error("your wallet returned no signature for that parcel");

  // taproot: 64 bytes = SIGHASH_DEFAULT (ALL), 65 = the type is the last byte.
  // ECDSA (p2wpkh/p2sh): the type is the last byte of the DER blob.
  const flag = input.tapKeySig
    ? (sig.length === 65 ? sig[64] : 0x00)
    : sig[sig.length - 1];

  if (flag !== SIGHASH_SINGLE_ANYONECANPAY) {
    throw new Error(
      `your wallet signed this with sighash 0x${flag.toString(16).padStart(2, "0")} instead of 0x83. ` +
      "A listing needs SIGHASH_SINGLE | ANYONECANPAY so a buyer can complete it — " +
      "without it the offer could never be spent, so it has not been saved.");
  }
  return flag;
}

export { u82b64, b642u8, hex2u8 };
