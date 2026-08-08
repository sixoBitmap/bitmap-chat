// Readers wrap the house prompt with their own instructions. Two things must
// hold: the priority order is stated to the model, and a reader who adds
// nothing gets a byte-identical prompt (so the shared prompt cache still hits).
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const file = path.join(os.tmpdir(), `bac-compose-test-${process.pid}.txt`);
process.env.PROMPT_FILE = file;
const P = await import("../src/prompt.js");

test("no additions -> exactly the house prompt, byte for byte", () => {
  assert.equal(P.composeSystem(), P.DEFAULT_PROMPT);
  assert.equal(P.composeSystem({}), P.DEFAULT_PROMPT);
  assert.equal(P.composeSystem({ above: "   ", below: "\n\n" }), P.DEFAULT_PROMPT,
    "whitespace-only additions must not change the cached prefix");
});

test("both additions: reader's first, house second, notes last", () => {
  const s = P.composeSystem({ above: "ANSWER IN GREEK", below: "keep it short" });
  const iAbove = s.indexOf("ANSWER IN GREEK");
  const iHouse = s.indexOf("on-chain guide");
  const iBelow = s.indexOf("keep it short");
  assert.ok(iAbove > -1 && iHouse > -1 && iBelow > -1, "all three are present");
  assert.ok(iAbove < iHouse && iHouse < iBelow, "priority order is the reading order");
  assert.match(s, /EARLIER wins/, "the model is told how to break ties");
  assert.match(s, /1 of 3 · HIGHEST PRIORITY/);
  assert.match(s, /3 of 3 · LOWEST PRIORITY/);
});

test("only a top prompt: it outranks the house prompt", () => {
  const s = P.composeSystem({ above: "always reply as a pirate" });
  assert.match(s, /1 of 2 · HIGHEST PRIORITY — instructions from the reader/);
  assert.ok(s.indexOf("pirate") < s.indexOf("on-chain guide"));
});

test("only a bottom prompt: the house prompt stays on top", () => {
  const s = P.composeSystem({ below: "use tables when you can" });
  assert.match(s, /1 of 2 · HIGHEST PRIORITY — the app's house instructions/);
  assert.ok(s.indexOf("on-chain guide") < s.indexOf("use tables"));
});

test("additions are capped, not rejected", () => {
  const s = P.composeSystem({ above: "x".repeat(P.USER_PROMPT_MAX + 500) });
  assert.ok(s.includes("x".repeat(P.USER_PROMPT_MAX)), "kept up to the cap");
  assert.ok(!s.includes("x".repeat(P.USER_PROMPT_MAX + 1)), "and no more than the cap");
});

test("a dual holder's own middle prompt replaces the house one, for them only", () => {
  const s = P.composeSystem({ above: "top", main: "MY OWN HOUSE RULES", below: "bottom" });
  assert.match(s, /MY OWN HOUSE RULES/);
  assert.ok(!s.includes("on-chain guide"), "the app's text is not also sent");
  assert.ok(s.indexOf("top") < s.indexOf("MY OWN HOUSE RULES"), "still second in priority");
  assert.ok(s.indexOf("MY OWN HOUSE RULES") < s.indexOf("bottom"));
  assert.equal(P.systemPrompt(), P.DEFAULT_PROMPT, "the app-wide prompt is untouched");
});

test("a middle prompt on its own is allowed, and gets a bigger cap", () => {
  const long = "z".repeat(P.USER_MAIN_MAX + 100);
  const s = P.composeSystem({ main: long });
  assert.ok(P.USER_MAIN_MAX > P.USER_PROMPT_MAX);
  assert.ok(s.includes("z".repeat(P.USER_MAIN_MAX)));
  assert.ok(!s.includes("z".repeat(P.USER_MAIN_MAX + 1)));
  assert.match(s, /1 of 1 · HIGHEST PRIORITY/);
});

test("the composed prompt follows an admin edit", () => {
  P.setPrompt("HOUSE RULES: only speak about sats and nothing else at all.");
  const s = P.composeSystem({ above: "mine" });
  assert.match(s, /HOUSE RULES/);
  assert.ok(!s.includes("on-chain guide"), "the old default is gone");
  P.resetPrompt();
});

test.after(() => { try { fs.unlinkSync(file); } catch {} });
