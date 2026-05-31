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
  rotateKey,
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

test("api-keys: per-user scoping isolates listings and protects delete", async () => {
  const userA = "u_alice000";
  const userB = "u_bob00000";
  const a1 = await createKey("alice 1", { userId: userA });
  const a2 = await createKey("alice 2", { userId: userA });
  const b1 = await createKey("bob 1", { userId: userB });

  const aList = await listKeys(userA);
  const aIds = aList.map((k) => k.id).sort();
  assert.deepEqual(aIds, [a1.record.id, a2.record.id].sort());
  for (const k of aList) assert.equal(k.userId, userA);

  const bList = await listKeys(userB);
  assert.equal(bList.length, 1);
  assert.equal(bList[0].id, b1.record.id);

  // Bob cannot delete Alice's key
  const stolen = await deleteKey(a1.record.id, userB);
  assert.equal(stolen, false);
  const stillThere = await loadKey(a1.record.id);
  assert.ok(stillThere);

  // Bob cannot revoke Alice's key
  const stolenRevoke = await revokeKey(a1.record.id, userB);
  assert.equal(stolenRevoke, false);
  const stillUnrevoked = await loadKey(a1.record.id);
  assert.ok(stillUnrevoked && !stillUnrevoked.revoked);

  // Owner can
  assert.equal(await deleteKey(a2.record.id, userA), true);
});

test("api-keys: expiresInDays sets expiresAt and findByPlaintext rejects expired", async () => {
  const { record, plaintext } = await createKey("short-lived", {
    userId: "u_carol000",
    expiresInDays: 7,
  });
  assert.ok(record.expiresAt);
  assert.ok(record.expiresAt! > Date.now());
  assert.equal(record.expired, false);

  const fresh = await findByPlaintext(plaintext);
  assert.ok(fresh);

  // Force-expire on disk and re-check.
  const rec = await loadKey(record.id);
  assert.ok(rec);
  rec!.expiresAt = Date.now() - 1000;
  fs.writeFileSync(path.join(tmp, `${record.id}.json`), JSON.stringify(rec));
  const expired = await findByPlaintext(plaintext);
  assert.equal(expired, null);
});

test("api-keys: rotate issues a new secret while preserving id, label, and usage", async () => {
  const userId = "u_dan00000";
  const { record, plaintext } = await createKey("webhook signer", { userId });
  await recordUse(record.id);
  await recordUse(record.id);

  // Cross-user rotation is refused.
  const stolen = await rotateKey(record.id, "u_eve00000");
  assert.equal(stolen, null);

  const before = await loadKey(record.id);
  assert.ok(before);

  const rotated = await rotateKey(record.id, userId);
  assert.ok(rotated);
  assert.notEqual(rotated!.plaintext, plaintext);
  assert.equal(rotated!.record.id, record.id);
  assert.equal(rotated!.record.label, "webhook signer");
  assert.equal(rotated!.record.usageCount, 2);
  assert.equal(rotated!.record.userId, userId);
  assert.equal(rotated!.record.prefix, rotated!.plaintext.slice(0, 12));

  // Old secret no longer authenticates.
  const oldMatch = await findByPlaintext(plaintext);
  assert.equal(oldMatch, null);
  // New secret does.
  const newMatch = await findByPlaintext(rotated!.plaintext);
  assert.ok(newMatch);
  assert.equal(newMatch!.id, record.id);

  // Revoked keys cannot be rotated.
  await revokeKey(record.id, userId);
  const denied = await rotateKey(record.id, userId);
  assert.equal(denied, null);
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
