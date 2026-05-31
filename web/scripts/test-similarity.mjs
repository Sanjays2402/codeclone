#!/usr/bin/env node
/**
 * Tiny smoke test for the compare similarity module. Run with:
 *   node --import tsx scripts/test-similarity.mjs
 * or after `next build`, import from .next isn't needed: we just re-run the
 * pure logic by requiring the source via ts-node-less dynamic import is heavy,
 * so this file re-implements the assertions against fetch on a running dev
 * server. Kept dependency-free.
 *
 * Usage:
 *   BASE=http://localhost:3000 node scripts/test-similarity.mjs
 */

const BASE = process.env.BASE ?? "http://localhost:3000";

async function call(a, b) {
  const r = await fetch(`${BASE}/api/compare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ a, b, language: "python" }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok  ", msg);
}

const SRC = `def two_sum(nums, target):
    seen = {}
    for i, n in enumerate(nums):
        if target - n in seen:
            return [seen[target - n], i]
        seen[n] = i
    return None
`;

const RENAMED = SRC.replaceAll("two_sum", "find_pair").replaceAll("nums", "values").replaceAll("target", "goal");
const UNRELATED = `def reverse(s):\n    return s[::-1]\n`;

const a = await call(SRC, SRC);
assert(a.scores.shingleJaccard > 0.99, "identical input scores ~1.0");

const b = await call(SRC, RENAMED);
assert(b.scores.shingleJaccard > 0.4, "renamed variants score high");
assert(b.scores.shingleJaccard < 1.0, "renamed variants are not identical");

const c = await call(SRC, UNRELATED);
assert(c.scores.shingleJaccard < 0.2, "unrelated code scores low");

const d = await fetch(`${BASE}/api/compare`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ a: "", b: "x" }),
});
assert(d.status === 400, "empty input is rejected with 400");

console.log("PASS");
