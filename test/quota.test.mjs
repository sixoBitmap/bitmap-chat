// Free-question ledger: counts how many of the daily allowance an address has
// spent (allowance itself = 1 + PathScribers + parcels, computed in wallet.js).
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const file = path.join(os.tmpdir(), `bac-quota-test-${process.pid}.json`);
process.env.QUOTA_FILE = file;
const { freeUsedToday, useFree, refundFree } = await import("../src/quota.js");
const ADDR = "bc1qtestaddress000000000000000000000000000";
const today = () => new Date().toISOString().slice(0, 10);

test("a fresh address has used nothing today", () => {
  assert.equal(freeUsedToday(ADDR), 0);
});

test("uses accumulate — a wallet with several PathScribers can spend several", () => {
  useFree(ADDR); useFree(ADDR); useFree(ADDR);
  assert.equal(freeUsedToday(ADDR), 3);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(onDisk[ADDR], { day: today(), used: 3 });
});

test("refund gives exactly one back, and never goes negative", () => {
  refundFree(ADDR);
  assert.equal(freeUsedToday(ADDR), 2);
  refundFree(ADDR); refundFree(ADDR); refundFree(ADDR);
  assert.equal(freeUsedToday(ADDR), 0);
});

test("yesterday's uses don't count today (day rollover)", async () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  fs.writeFileSync(file, JSON.stringify({ [ADDR]: { day: yesterday, used: 9 } }));
  const q = await import(`../src/quota.js?fresh=${Date.now()}`);
  assert.equal(q.freeUsedToday(ADDR), 0, "a new day means a fresh allowance");
});

test("the old one-free-question format still reads as 1 used", async () => {
  fs.writeFileSync(file, JSON.stringify({ [ADDR]: today() })); // legacy: bare day string
  const q = await import(`../src/quota.js?legacy=${Date.now()}`);
  assert.equal(q.freeUsedToday(ADDR), 1);
});

test.after(() => { try { fs.unlinkSync(file); } catch {} });
