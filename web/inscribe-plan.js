// PURE inscription planner — no DOM, no network, no wallet, no crypto.
//
// Given the inscription you clicked in the tree (the anchor) plus what you
// want to make, it works out the exact inputs, outputs and ord `pointer` of
// the reveal transaction. The browser imports it to build the real thing; the
// test suite imports the same file, so every arithmetic rule below is checked
// without spending a satoshi.
//
// The three rules that cost money if they are wrong:
//
//   1. POINTER. ord assigns the new inscription to the sat at byte-offset
//      `pointer` across the reveal's outputs. It must equal the summed value
//      of every output BEFORE the one meant to carry it, and must be strictly
//      less than the total output value — at or past the total, ord hands the
//      inscription to the miner and you still pay in full.
//   2. REINSCRIPTION POSTAGE. Output 0 reproduces the input's sat range only
//      up to its own value. Paying out less than the anchor UTXO holds sends
//      the remaining sats — and anything else inscribed on them — to the
//      miner. So postage is locked to the anchor's own value, never chosen.
//   3. PARENTS ARE OWNERSHIP PROOFS. A parent only counts if its UTXO is an
//      input of the reveal, which needs its holder's signature. Tag a parent
//      you cannot spend and the transaction still succeeds, still costs full
//      price, and ord silently drops the parent. Never allowed through.

export const DUST = 546;          // every output we create
export const MIN_OUT = 330;       // hard floor, below this is unspendable dust
export const MAX_BODY = 350_000;  // refuse absurd payloads before the wallet opens
export const MAX_INPUTS = 8;      // keeps the reveal comfortably standard
export const META_MAX = 4000;     // metadata rides in the same witness as the body
export const ID_RE = /^[0-9a-f]{64}i\d+$/;

class PlanError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
const bad = (message, code) => { throw new PlanError(message, code); };

const outpoint = (u) => `${u.txid}:${u.vout}`;

// Every UTXO we spend must come back to us whole: the output reproduces the
// input's full sat range, so nothing riding on those sats can be lost.
function utxoOk(u, what) {
  if (!u || typeof u.txid !== "string" || !/^[0-9a-f]{64}$/.test(u.txid)) bad(`${what}: no transaction id — reload and try again`, "utxo");
  if (!Number.isInteger(u.vout) || u.vout < 0) bad(`${what}: bad output index`, "utxo");
  if (!Number.isInteger(u.value) || u.value < MIN_OUT) bad(`${what}: only ${u.value} sats, too small to spend safely`, "utxo");
  if (!Number.isInteger(u.offset) || u.offset < 0) bad(`${what}: unknown position on its sat`, "utxo");
}

/**
 * @param {object} o
 * @param {"reinscription"|"child"} o.relation
 * @param {"text"|"file"|"delegate"} o.payload
 * @param {object} o.anchor        the clicked inscription: {id,txid,vout,offset,value,address}
 * @param {object[]} [o.extraParents]  further parents, same shape (child only)
 * @param {number} [o.postage]     sats on the new inscription (child only; ignored for reinscription)
 * @param {string} [o.contentType] required for text/file
 * @param {string} [o.delegate]    required for delegate
 * @param {number} [o.bodyBytes]   payload size, for the size guard
 * @param {string} o.ordAddress    where everything is sent back — the connected ordinals address
 */
export function planInscription(o) {
  const { relation, payload, anchor, ordAddress } = o;
  const extraParents = o.extraParents || [];

  if (relation !== "reinscription" && relation !== "child") bad("pick reinscription or child first", "relation");
  if (!["text", "file", "delegate"].includes(payload)) bad("pick what to inscribe", "payload");
  if (!ordAddress) bad("connect your wallet first", "wallet");
  if (!anchor?.id || !ID_RE.test(anchor.id)) bad("that row has no usable inscription id", "anchor");
  utxoOk(anchor, "the inscription you picked");

  // You can only build on something you can spend.
  if (anchor.address !== ordAddress) {
    bad(`that sat now sits in ${anchor.address || "another wallet"} — connect the wallet that holds it`, "not-yours");
  }

  // --- payload ---------------------------------------------------------------
  const tags = {};
  if (payload === "delegate") {
    if (!o.delegate || !ID_RE.test(o.delegate)) bad("a delegate needs an inscription id like abc…123i0", "delegate");
    tags.delegate = o.delegate;                       // tag 11, and NO body
  } else {
    if (!o.contentType) bad("choose a content type", "content-type");
    if (!o.bodyBytes) bad("there is nothing to inscribe yet", "empty");
    if (o.bodyBytes > MAX_BODY) bad(`that is ${o.bodyBytes.toLocaleString("en-US")} bytes — too big to inscribe here (limit ${MAX_BODY.toLocaleString("en-US")})`, "too-big");
    tags.contentType = o.contentType;
  }

  // --- metadata (tag 5) -------------------------------------------------------
  // ord stores metadata as CBOR and serves it back at /r/metadata/<id>.
  // micro-ordinals does the CBOR itself, so what goes in the tag is a plain JS
  // value: an object when the text is JSON, otherwise the text as a string.
  if (o.metadata !== undefined && o.metadata !== null && o.metadata !== "") {
    const raw = typeof o.metadata === "string" ? o.metadata.trim() : o.metadata;
    if (typeof raw === "string" && raw.length > META_MAX) {
      bad(`the metadata is too long (${raw.length} of ${META_MAX} characters)`, "meta-too-big");
    }
    tags.metadata = raw;
  }

  // --- inputs, outputs, pointer ----------------------------------------------
  const ins = [];
  const outs = [];
  const seen = new Map();               // outpoint -> index in ins

  // the anchor is always input 0, and always comes back whole
  ins.push({ ...anchor, role: "anchor" });
  seen.set(outpoint(anchor), 0);

  let pointer, parentIds = [];

  // In CHILD mode the clicked inscription becomes the first parent. In
  // REINSCRIPTION mode it is only the sat we land on — but extra parents are
  // still allowed: the parent tag and the sat are independent of each other.
  if (relation === "child") {
    parentIds.push(anchor.id);
    outs.push({ to: ordAddress, value: anchor.value, role: "parent", id: anchor.id });
  } else {
    // This output both returns the anchor's sats and carries the new
    // inscription, at the anchor's own offset.
    //
    // Left alone it reproduces the WHOLE input, so nothing bundled on those sats
    // can be lost. An explicit smaller choice is honoured — it is the caller's
    // sats — but never below the dust floor, and never so small that the sat we
    // are inscribing on falls outside the output (that would hand the whole
    // thing to the miner). Larger is always fine; the commit tops it up.
    const post = o.postage != null
      ? Math.max(MIN_OUT, anchor.offset + 1, Number(o.postage))
      : Math.max(DUST, anchor.value);
    outs.push({ to: ordAddress, value: post, role: "inscription", also: "anchor" });
    pointer = anchor.offset;            // land on the very sat that was clicked
    if (pointer >= post) {
      bad(`this sat sits ${anchor.offset} sats into its output, past the ${post} being paid out — cannot reinscribe it safely`, "pointer");
    }
  }

  for (const p of extraParents) {
    if (!p?.id || !ID_RE.test(p.id)) bad("one of the extra parents is not an inscription id", "parent-id");
    if (p.id === anchor.id) bad("that is the inscription you started from — no need to add it again", "parent-dup");
    if (parentIds.includes(p.id)) bad(`${p.id.slice(0, 10)}… is listed twice`, "parent-dup");
    utxoOk(p, "extra parent");
    // RULE 3 — the whole reason this is a hard block and not a warning
    if (p.address !== ordAddress) {
      bad(`you don't hold ${p.id.slice(0, 10)}… — a parent has to be spent by its owner, so it cannot be added from this wallet`, "parent-not-yours");
    }
    parentIds.push(p.id);
    // two parents can share one UTXO (bundled inscriptions): spend it once,
    // return it once, but keep BOTH parent tags — ord reads every inscription
    // carried by any input as a potential parent
    const key = outpoint(p);
    if (!seen.has(key)) {
      seen.set(key, ins.length);
      ins.push({ ...p, role: "parent" });
      outs.push({ to: ordAddress, value: p.value, role: "parent", id: p.id });
    }
  }

  if (relation === "child") {
    const post = Number(o.postage ?? DUST);
    if (!Number.isInteger(post) || post < MIN_OUT) bad(`postage must be at least ${MIN_OUT} sats`, "postage");
    // RULE 1: the child lands after every returned parent
    pointer = outs.reduce((s, x) => s + x.value, 0);
    outs.push({ to: ordAddress, value: post, role: "inscription" });
  }
  if (parentIds.length) tags.parent = parentIds.length === 1 ? parentIds[0] : parentIds;

  tags.pointer = pointer;

  if (ins.length + 1 > MAX_INPUTS) bad(`too many parents — at most ${MAX_INPUTS - 2} extra`, "too-many-inputs");

  const outTotal = outs.reduce((s, x) => s + x.value, 0);
  const inTotal = ins.reduce((s, x) => s + x.value, 0);
  const postage = outs.find((x) => x.role === "inscription").value;

  // --- invariants: the last line of defence before real money -----------------
  const at = outs.findIndex((x) => x.role === "inscription");
  const before = outs.slice(0, at).reduce((s, x) => s + x.value, 0);
  // A child lands on a whole new output, so the pointer sits on that boundary.
  // A reinscription lands INSIDE the returned anchor output, at the very sat
  // that was clicked — so its own offset is added on.
  const wantPointer = before + (relation === "reinscription" ? anchor.offset : 0);
  if (pointer !== wantPointer) bad(`internal: pointer ${pointer} does not land on the new inscription (${wantPointer})`, "bug-pointer");
  if (pointer >= outTotal) bad(`internal: pointer ${pointer} is past the outputs (${outTotal}) — that would pay the inscription to the miner`, "bug-pointer-lost");
  if (outs.some((x) => x.value < MIN_OUT)) bad("internal: an output is below the dust floor", "bug-dust");
  // PARENTS always come back whole — they are somebody's inscriptions and we
  // only borrowed them to prove ownership. The anchor of a reinscription is the
  // one exception: the caller may deliberately pay out less of their own output
  // (see `burned` below), which is their sats to spend.
  for (const i of ins) {
    if (i.role === "anchor" && relation === "reinscription") continue;
    const back = outs.some((x) => (x.id === i.id || (x.also === "anchor" && i.role === "anchor")) && x.value >= i.value);
    if (!back) bad(`internal: ${i.role} input ${i.id?.slice(0, 10)}… is not returned in full`, "bug-return");
  }
  // outputs minus inputs: what the commit must add (positive) or what is being
  // left behind as fee (negative, reinscription with a smaller postage)
  const fromCommit = outTotal - inTotal;
  if (fromCommit !== (relation === "child" ? postage : postage - anchor.value)) {
    bad("internal: inputs and outputs do not balance", "bug-balance");
  }
  // sats of the anchor's output deliberately not paid out — they go to the miner
  const burned = relation === "reinscription" ? Math.max(0, anchor.value - postage) : 0;

  return {
    relation, payload, tags, pointer, parentIds, postage, burned,
    ins, outs, inTotal, outTotal,
    // what the commit output must fund: the reveal fee plus whatever postage
    // the spent inscription UTXOs cannot cover themselves
    commitValue: (revealFee) => Math.max(360, relation === "child"
      ? revealFee + postage
      : revealFee + postage - anchor.value),
  };
}

// Human-readable one-liner for the review screen.
export const describePlan = (p) =>
  p.relation === "reinscription"
    ? `reinscription on the same sat · ${p.payload} · ${p.postage} sats`
    : `child of ${p.parentIds.length} parent${p.parentIds.length > 1 ? "s" : ""} · ${p.payload} · ${p.postage} sats`;
