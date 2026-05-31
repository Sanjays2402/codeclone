/**
 * Run with: node --test --experimental-strip-types web/tests/onboarding.test.ts
 *
 * Black-box test for the onboarding state machine. Points every backing
 * store at a fresh temp directory so it never touches real data.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-onboarding-"));
process.env.CODECLONE_KEYS_DIR = path.join(root, "api-keys");
process.env.CODECLONE_SHARES_DIR = path.join(root, "shares");
process.env.CODECLONE_USAGE_DIR = path.join(root, "usage");
process.env.CODECLONE_ONBOARDING_FILE = path.join(root, ".onboarding.json");
fs.mkdirSync(process.env.CODECLONE_KEYS_DIR, { recursive: true });
fs.mkdirSync(process.env.CODECLONE_SHARES_DIR, { recursive: true });

const { getOnboarding, dismissOnboarding, markCompared, resetOnboarding } =
  await import("../lib/onboarding.ts");
const { createKey, revokeKey } = await import("../lib/api-keys.ts");
// createShare is imported inline within the relevant test to keep top-level tidy.

test("onboarding: starts at 0/3 with no derived signals", async () => {
  await resetOnboarding();
  const s = await getOnboarding();
  assert.equal(s.total, 3);
  assert.equal(s.completed, 0);
  assert.equal(s.dismissed, false);
  assert.deepEqual(
    s.steps.map((x) => x.id),
    ["create_key", "run_compare", "save_share"],
  );
  for (const step of s.steps) assert.equal(step.done, false);
});

test("onboarding: creating an active API key marks step 1 done", async () => {
  await createKey("welcome flow");
  const s = await getOnboarding();
  assert.equal(s.steps[0].done, true);
  assert.equal(s.completed, 1);
});

test("onboarding: revoked keys do not count", async () => {
  await resetOnboarding();
  // Clear out keys from the previous test.
  const keysDir = process.env.CODECLONE_KEYS_DIR as string;
  for (const f of fs.readdirSync(keysDir)) fs.rmSync(path.join(keysDir, f), { recursive: true, force: true });
  const { record } = await createKey("about to revoke");
  await revokeKey(record.id);
  const s = await getOnboarding();
  assert.equal(s.steps[0].done, false);
});

test("onboarding: markCompared flips step 2 done and persists", async () => {
  await markCompared();
  const s1 = await getOnboarding();
  assert.equal(s1.steps[1].done, true);
  // Persisted across a fresh call.
  const s2 = await getOnboarding();
  assert.equal(s2.steps[1].done, true);
});

test("onboarding: saving a share flips step 3 done and sets finishedAt at 3/3", async () => {
  await createKey("for final step");
  const { createShare } = await import("../lib/share.ts");
  await createShare({
    a: "function add(a, b) { return a + b; }",
    b: "function sum(x, y) { return x + y; }",
    language: "javascript",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result: {
      language: "javascript",
      scores: {
        cosine_tfidf: 0.9,
        shingle_jaccard: 0.85,
        token_jaccard: 0.7,
        levenshtein_ratio: 0.6,
      },
      alignment: { hunks: [] },
      clone: { label: "near-duplicate", confidence: 0.9 },
      bytes: { a: 40, b: 40 },
      latency_ms: 1,
      method: "test",
    } as any,
  });
  const s = await getOnboarding();
  assert.equal(s.steps[2].done, true);
  assert.equal(s.completed, 3);
  assert.ok(s.finishedAt && s.finishedAt > 0, "finishedAt should be stamped when all steps complete");
});

test("onboarding: dismiss sets dismissed=true and is idempotent", async () => {
  await dismissOnboarding();
  const s1 = await getOnboarding();
  assert.equal(s1.dismissed, true);
  await dismissOnboarding();
  const s2 = await getOnboarding();
  assert.equal(s2.dismissed, true);
});
