// Commit/reveal transaction builder for the inscribe tool.
//
// Ported from btcmail's calendar builder, which has been making these exact
// transactions on mainnet. Generalised here to N parent inputs and to the
// text / file / delegate payloads.
//
// The shape never changes:
//   COMMIT   funded from the wallet's PAYMENT address -> one output to an
//            ephemeral taproot address that carries the ord envelope.
//   REVEAL   inputs  = [the inscription you clicked, ...extra parents, commit]
//            outputs = every spent inscription back to you, then the new one.
//
// Both are signed BEFORE either is broadcast, so an abandoned signature leaves
// nothing on chain. The commit output is script-path-only against an ephemeral
// key: if the commit were broadcast without a signed reveal, those sats would
// be unspendable forever.

const LIBS = {};
export async function inscLibs() {
  if (LIBS.btc) return LIBS;
  const [btc, ordl, curves] = await Promise.all([
    import("https://esm.sh/@scure/btc-signer@1.8.0"),
    import("https://esm.sh/micro-ordinals@0.2.2"),
    import("https://esm.sh/@noble/curves@1.8.1/secp256k1"),
  ]);
  Object.assign(LIBS, { btc, ordl, schnorr: curves.schnorr });
  return LIBS;
}

export const hex2u8 = (s) => Uint8Array.from((s.match(/../g) || []).map((b) => parseInt(b, 16)));
export const u82hex = (u) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
export const u82b64 = (u) => btoa(String.fromCharCode(...u));
export const b642u8 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const xonly = (pubHex) => { const u = hex2u8(pubHex); return u.length === 33 ? u.slice(1) : u; };

// The payment address's script + how many vBytes one of its inputs costs.
export function payScript(btc, { payAddress, payPubkey }) {
  if (!payAddress || !payPubkey) throw new Error("reconnect your wallet — its payment address is unknown");
  const pub = hex2u8(payPubkey);
  if (payAddress.startsWith("bc1q")) { const p = btc.p2wpkh(pub, btc.NETWORK); return { addr: payAddress, script: p.script, extra: {}, inVB: 68 }; }
  if (payAddress.startsWith("3")) { const p = btc.p2sh(btc.p2wpkh(pub, btc.NETWORK), btc.NETWORK); return { addr: payAddress, script: p.script, extra: { redeemScript: p.redeemScript }, inVB: 91 }; }
  if (payAddress.startsWith("bc1p")) { const k = xonly(payPubkey); const p = btc.p2tr(k, undefined, btc.NETWORK); return { addr: payAddress, script: p.script, extra: { tapInternalKey: k }, inVB: 58 }; }
  throw new Error("this wallet's payment address type is not supported");
}

// plan (from inscribe-plan.js) + body -> the ord envelope micro-ordinals wants.
export function buildEnvelope(plan, body) {
  const tags = { pointer: BigInt(plan.tags.pointer) };
  if (plan.tags.contentType) tags.contentType = plan.tags.contentType;
  if (plan.tags.delegate) tags.delegate = plan.tags.delegate;
  if (plan.tags.parent) tags.parent = plan.tags.parent;
  // tag 5 — micro-ordinals CBOR-encodes whatever value we hand it
  if (plan.tags.metadata !== undefined) tags.metadata = plan.tags.metadata;
  return { tags, body: body || new Uint8Array(0) };
}

// Decode the script we are about to pay for and prove it says what we meant.
// This is the only check that exercises the real byte encoder — reversed txid,
// trimmed little-endian index — which is where an id-encoding bug would hide.
export function verifyEnvelope(btc, ordl, script, plan) {
  const got = ordl.parseInscriptions(btc.Script.decode(script), true);
  if (!got?.length) throw new Error("the inscription could not be read back from its own script");
  const t = got[0].tags || {};
  const want = plan.tags;
  if (Number(t.pointer ?? 0) !== Number(want.pointer)) throw new Error(`pointer mismatch: encoded ${t.pointer}, meant ${want.pointer}`);
  if (want.delegate && t.delegate !== want.delegate) throw new Error("the delegate id did not survive encoding");
  if (want.contentType && t.contentType !== want.contentType) throw new Error("the content type did not survive encoding");
  if (want.metadata !== undefined && JSON.stringify(t.metadata) !== JSON.stringify(want.metadata)) {
    throw new Error("the metadata did not survive CBOR encoding");
  }
  if (want.parent) {
    const wanted = Array.isArray(want.parent) ? want.parent : [want.parent];
    const encoded = t.parent ? (Array.isArray(t.parent) ? t.parent : [t.parent]) : [];
    if (encoded.length !== wanted.length || wanted.some((p, i) => encoded[i] !== p)) {
      throw new Error(`parents did not survive encoding: meant ${wanted.length}, encoded ${encoded.length}`);
    }
  }
  return got[0];
}

// Same proof for a batch: decode the script we are about to pay for and check
// every envelope came out with the parent and pointer it was meant to have.
export function verifyBatch(btc, ordl, script, plan) {
  const got = ordl.parseInscriptions(btc.Script.decode(script), true);
  if (!got || got.length !== plan.envelopes.length) {
    throw new Error(`the script holds ${got?.length ?? 0} inscriptions, not the ${plan.envelopes.length} intended`);
  }
  const dec = new TextDecoder();
  plan.envelopes.forEach((want, i) => {
    const t = got[i].tags || {};
    if (Number(t.pointer ?? -1) !== Number(want.tags.pointer)) {
      throw new Error(`inscription ${i + 1}: pointer encoded ${t.pointer}, meant ${want.tags.pointer}`);
    }
    if (t.parent !== want.tags.parent) throw new Error(`inscription ${i + 1}: the parent did not survive encoding`);
    if (dec.decode(got[i].body) !== want.text) throw new Error(`inscription ${i + 1}: the content did not survive encoding`);
  });
  return got;
}

/**
 * Build and sign both transactions. Broadcasts nothing.
 * @returns {{commitHex,commitTxid,revealHex,revealTxid,newInscriptionId,fees}}
 */
export async function buildInscribeTxs({ plan, body, feeRate, pay, ordPubkey, utxos, signPsbt, onStep }) {
  const { btc, ordl, schnorr } = await inscLibs();
  const NET = btc.NETWORK;
  const ordAddr = plan.outs[0].to;

  onStep?.(plan.envelopes ? `Building ${plan.count} inscriptions…` : "Building the inscription…");
  // A batch plan carries many envelopes in one tapscript, each with its own
  // pointer; a single plan carries one. Everything downstream is identical.
  const enc = new TextEncoder();
  const envelopes = plan.envelopes
    ? plan.envelopes.map((e) => ({
        tags: { contentType: e.tags.contentType, parent: e.tags.parent, pointer: BigInt(e.tags.pointer) },
        body: enc.encode(e.text),
      }))
    : [buildEnvelope(plan, body)];
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = schnorr.getPublicKey(priv);
  const revealScript = ordl.p2tr_ord_reveal(pub, envelopes);
  const revealP = btc.p2tr(undefined, revealScript, NET, false, [ordl.OutOrdinalReveal]);
  if (plan.envelopes) verifyBatch(btc, ordl, revealScript.script, plan);
  else verifyEnvelope(btc, ordl, revealScript.script, plan);

  // assemble the reveal: every planned input, then the commit, then the outputs
  const mkReveal = (ins, commitTxid, commitVal) => {
    const tx = new btc.Transaction({ customScripts: [ordl.OutOrdinalReveal] });
    for (const i of ins) tx.addInput({ ...i, sequence: 0xfffffffd });
    tx.addInput({
      ...revealP, txid: commitTxid, index: 0,
      witnessUtxo: { script: revealP.script, amount: commitVal }, sequence: 0xfffffffd,
    });
    for (const o of plan.outs) tx.addOutputAddress(o.to, BigInt(o.value), NET);
    return tx;
  };

  // exact reveal size: sign a throwaway twin with the same shapes
  onStep?.("Working out the exact fee…");
  const dPriv = crypto.getRandomValues(new Uint8Array(32));
  const dPub = schnorr.getPublicKey(dPriv);
  const dP2tr = btc.p2tr(dPub, undefined, NET);
  const dummy = mkReveal(
    plan.ins.map((u, k) => ({
      txid: String(k + 11).padStart(2, "1").repeat(32).slice(0, 64),
      index: 0, witnessUtxo: { script: dP2tr.script, amount: BigInt(u.value) }, tapInternalKey: dPub,
    })),
    "22".repeat(32), 100000n);
  for (let i = 0; i < plan.ins.length; i++) dummy.signIdx(dPriv, i);
  dummy.signIdx(priv, plan.ins.length);
  dummy.finalize();
  const revealFee = Math.ceil(dummy.vsize * feeRate);
  const commitValue = BigInt(plan.commitValue(revealFee));

  // fund the commit from the payment address (confirmed coins only — an
  // unconfirmed parent would make the whole chain unrelayable)
  onStep?.("Choosing coins…");
  const ps = payScript(btc, pay);
  const spendable = utxos.filter((u) => u.confirmed).sort((a, b) => b.value - a.value);
  const OUT_VB = 43;
  let chosen = [], have = 0, commitFee = 0;
  for (const u of spendable) {
    chosen.push(u); have += u.value;
    commitFee = Math.ceil((10.5 + chosen.length * ps.inVB + OUT_VB * 2) * feeRate);
    if (have >= Number(commitValue) + commitFee) break;
  }
  if (have < Number(commitValue) + commitFee) {
    throw new Error(`not enough confirmed bitcoin in your payment address — need about ${(Number(commitValue) + commitFee).toLocaleString("en-US")} sats, found ${have.toLocaleString("en-US")}`);
  }
  const change = BigInt(have) - commitValue - BigInt(commitFee);
  const commit = new btc.Transaction();
  for (const u of chosen) {
    commit.addInput({
      txid: u.txid, index: u.vout,
      witnessUtxo: { script: ps.script, amount: BigInt(u.value) },
      ...ps.extra,
      // NOT RBF: the reveal is pre-signed against this exact txid. If the
      // wallet replaced the commit, the reveal would be dead and the commit
      // output — script-path only — unspendable forever.
      sequence: 0xfffffffe,
    });
  }
  commit.addOutputAddress(revealP.address, commitValue, NET);
  if (change >= 546n) commit.addOutputAddress(ps.addr, change, NET);

  const finalizeAll = (tx) => {
    for (let i = 0; i < tx.inputsLength; i++) {
      try { tx.finalizeIdx(i); } catch (e) { if (!/final/i.test(String(e.message))) throw e; }
    }
  };

  onStep?.("Signature 1 of 2 — approve the funding transaction…");
  const cSigned = btc.Transaction.fromPSBT(await signPsbt(commit.toPSBT(), { [ps.addr]: chosen.map((_, i) => i) }));
  finalizeAll(cSigned);
  const commitHex = u82hex(cSigned.extract()), commitTxid = cSigned.id;

  // the real reveal, spending the freshly signed (still unbroadcast) commit
  const ordScript = btc.OutScript.encode(btc.Address(NET).decode(ordAddr));
  const reveal = mkReveal(plan.ins.map((u) => ({
    txid: u.txid, index: u.vout,
    witnessUtxo: { script: ordScript, amount: BigInt(u.value) },
    ...(ordPubkey ? { tapInternalKey: xonly(ordPubkey) } : {}),
  })), commitTxid, commitValue);

  onStep?.("Signature 2 of 2 — approve the inscription…");
  const rSigned = btc.Transaction.fromPSBT(
    await signPsbt(reveal.toPSBT(), { [ordAddr]: plan.ins.map((_, i) => i) }),
    { customScripts: [ordl.OutOrdinalReveal] });
  try { rSigned.signIdx(priv, plan.ins.length); } catch (e) { if (!/final/i.test(String(e.message))) throw e; }
  finalizeAll(rSigned);

  const revealTxid = rSigned.id;
  return {
    commitHex, commitTxid,
    revealHex: u82hex(rSigned.extract()), revealTxid,
    // envelopes are numbered in order within the reveal transaction
    newInscriptionId: `${revealTxid}i0`,
    newInscriptionIds: envelopes.map((_, i) => `${revealTxid}i${i}`),
    fees: { reveal: revealFee, commit: commitFee, commitValue: Number(commitValue), postage: plan.postage,
            total: revealFee + commitFee + plan.postage },
  };
}
