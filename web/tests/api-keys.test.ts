/**
 * Run with: node --test --experimental-strip-types web/tests/api-keys.test.ts
 *
 * Black-box test for the API key store. Uses a temp directory so it
 * never touches real data.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-keys-"));
process.env.CODECLONE_KEYS_DIR = tmp;

const {
  createKey,
  listKeys,
  loadKey,
  revokeKey,
  deleteKey,
  findByPlaintext,
  recordUse,
  extractBearer,
} = await import("../lib/api-keys.ts");

test("api-keys: create returns plaintext once and persists only hash", async () => {
  const { record, plaintext } = await createKey("CI runner");
  assert.equal(record.label, "CI runner");
  assert.ok(plaintext.startsWith("cc_live_"));
  assert.ok(plaintext.length > 20);
  assert.equal(record.prefix, plaintext.slice(0, 12));
  assert.equal(record.usageCount, 0);

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(tmp, `${record.id}.json`), "utf-8"),
  );
  assert.equal(onDisk.hash.length, 64); // sha-256 hex
  assert.ok(!JSON.stringify(onDisk).includes(plaintext));
});

test("api-keys: findByPlaintext matches and respects revocation", async () => {
  const { record, plaintext } = await createKey("dev");
  const hit = await findByPlaintext(plaintext);
  assert.ok(hit);
  assert.equal(hit!.id, record.id);

  await revokeKey(record.id);
  const miss = await findByPlaintext(plaintext);
  assert.equal(miss, null);

  // wrong key never matches
  const wrong = await findByPlaintext("cc_live_definitelynotreal");
  assert.equal(wrong, null);

  // wrong prefix is rejected fast
  const bad = await findByPlaintext("notaprefix");
  assert.equal(bad, null);
});

test("api-keys: recordUse increments counter and stamps lastUsedAt", async () => {
  const { record } = await createKey("metrics");
  await recordUse(record.id);
  await recordUse(record.id);
  const loaded = await loadKey(record.id);
  assert.ok(loaded);
  assert.equal(loaded!.usageCount, 2);
  assert.ok(loaded!.lastUsedAt && loaded!.lastUsedAt > 0);
});

test("api-keys: list and delete round-trip", async () => {
  const before = await listKeys();
  const { record } = await createKey("temp");
  const after = await listKeys();
  assert.equal(after.length, before.length + 1);

  const ok = await deleteKey(record.id);
  assert.equal(ok, true);
  const final = await listKeys();
  assert.equal(final.length, before.length);
});

test("api-keys: extractBearer handles Authorization and x-api-key", () => {
  const r1 = new Request("http://x", {
    headers: { Authorization: "Bearer cc_live_abc" },
  });
  assert.equal(extractBearer(r1), "cc_live_abc");

  const r2 = new Request("http://x", {
    headers: { "x-api-key": "cc_live_xyz" },
  });
  assert.equal(extractBearer(r2), "cc_live_xyz");

  const r3 = new Request("http://x");
  assert.equal(extractBearer(r3), null);
});
