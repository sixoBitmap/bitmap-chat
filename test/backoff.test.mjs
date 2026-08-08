// Backoff + cooldown behavior. No network: fetch is monkey-patched.
import test from "node:test";
import assert from "node:assert";

const { withRetry } = await import("../src/crawler.js");
const { fetchOrd } = await import("../src/oci.js");

test("withRetry waits out 429s (honoring retryAfter) and succeeds", async () => {
  let calls = 0;
  const t0 = Date.now();
  const result = await withRetry(() => {
    calls++;
    if (calls <= 2) { const e = new Error("429"); e.status = 429; e.retryAfter = 1; throw e; }
    return "ok";
  }, { tries: 4, base: 10 });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.ok(Date.now() - t0 >= 2000, `waited only ${Date.now() - t0}ms for two retry-after:1 responses`);
});

test("withRetry returns null on 404 without retrying", async () => {
  let calls = 0;
  const result = await withRetry(() => { calls++; const e = new Error("404"); e.notFound = true; throw e; });
  assert.equal(result, null);
  assert.equal(calls, 1);
});

test("withRetry degrades to null after final failure and reports via onFail", async () => {
  let calls = 0, failed = 0;
  const result = await withRetry(() => { calls++; throw new Error("boom"); }, { tries: 3, base: 5, onFail: () => failed++ });
  assert.equal(result, null);
  assert.equal(calls, 3);
  assert.equal(failed, 1);
});

// Must run last in this file: it puts the (only) gateway on cooldown.
test("fetchOrd: a 429 puts the gateway on cooldown — no re-contact, error carries retryAfter", async () => {
  const realFetch = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async () => { hits++; return new Response("slow down", { status: 429, headers: { "retry-after": "2" } }); };
  try {
    await assert.rejects(() => fetchOrd("/r/blockheight"), (e) => e.status === 429);
    const before = hits;
    await assert.rejects(() => fetchOrd("/r/blockheight"), (e) => e.status === 429 && e.retryAfter >= 1);
    assert.equal(hits, before, "a cooling gateway must not be re-contacted");
  } finally {
    globalThis.fetch = realFetch;
  }
});
