// The system prompt is editable live from the admin panel: saved to disk, read
// on every request, and always restorable to the built-in text.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const file = path.join(os.tmpdir(), `bac-prompt-test-${process.pid}.txt`);
process.env.PROMPT_FILE = file;
const P = await import("../src/prompt.js");

test("with nothing saved, the built-in prompt is used", () => {
  const s = P.promptState();
  assert.equal(s.isDefault, true);
  assert.equal(s.text, P.DEFAULT_PROMPT);
  assert.equal(s.savedAt, null);
  assert.ok(s.estTokens > 100, "reports a token estimate");
});

test("saving replaces it everywhere, immediately and on disk", () => {
  const text = "Answer only in haiku about bitmaps. ".repeat(3);
  const s = P.setPrompt(text);
  assert.equal(s.isDefault, false);
  assert.equal(P.systemPrompt(), text.trimEnd(), "the next request picks it up with no restart");
  assert.equal(fs.readFileSync(file, "utf8"), text.trimEnd(), "persisted for the next boot");
  assert.ok(s.savedAt > 0);
});

test("a saved prompt survives a restart", async () => {
  const fresh = await import(`../src/prompt.js?boot=${Date.now()}`);
  assert.equal(fresh.promptState().isDefault, false);
  assert.match(fresh.systemPrompt(), /haiku/);
});

test("restoring the default deletes the override", () => {
  const s = P.resetPrompt();
  assert.equal(s.isDefault, true);
  assert.equal(P.systemPrompt(), P.DEFAULT_PROMPT);
  assert.equal(fs.existsSync(file), false);
});

test("saving the default text back is treated as 'use the default'", () => {
  P.setPrompt("something custom enough to pass the minimum length check");
  const s = P.setPrompt(P.DEFAULT_PROMPT);
  assert.equal(s.isDefault, true, "not stored as a custom prompt identical to the default");
  assert.equal(fs.existsSync(file), false);
});

test("an empty or absurd prompt is refused, and the live one is untouched", () => {
  P.setPrompt("a perfectly reasonable custom prompt for the bitmap guide");
  const before = P.systemPrompt();
  for (const bad of ["", "   ", "too short", null, undefined]) {
    assert.throws(() => P.setPrompt(bad), /at least/, `rejected: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => P.setPrompt("x".repeat(P.PROMPT_MAX + 1)), /too long/);
  assert.equal(P.systemPrompt(), before, "a rejected save changes nothing");
});

test("a file too small to be a real prompt is ignored on boot", async () => {
  fs.writeFileSync(file, "oops");
  const fresh = await import(`../src/prompt.js?boot=${Date.now()}-2`);
  assert.equal(fresh.promptState().isDefault, true, "falls back to the default instead of shipping junk");
});

test.after(() => { try { fs.unlinkSync(file); } catch {} });
