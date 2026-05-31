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

test("api-keys: recordUse tracks recent source IPs as a bounded ring buffer", async () => {
  const { RECENT_IPS_LIMIT, summarize } = await import("../lib/api-keys.ts");
  const { record } = await createKey("ip-tracker");

  // First call from IP A -> single entry, count 1.
  await recordUse(record.id, "203.0.113.10");
  let loaded = await loadKey(record.id);
  assert.ok(loaded);
  assert.equal(loaded!.recentIps?.length, 1);
  assert.equal(loaded!.recentIps?.[0].ip, "203.0.113.10");
  assert.equal(loaded!.recentIps?.[0].count, 1);
  assert.ok(loaded!.recentIps?.[0].firstSeenAt > 0);
  assert.equal(loaded!.recentIps?.[0].firstSeenAt, loaded!.recentIps?.[0].lastSeenAt);

  // Second call from same IP A -> still one entry, count 2.
  await recordUse(record.id, "203.0.113.10");
  loaded = await loadKey(record.id);
  assert.equal(loaded!.recentIps?.length, 1);
  assert.equal(loaded!.recentIps?.[0].count, 2);

  // Call from a different IP B -> two entries.
  await recordUse(record.id, "198.51.100.7");
  loaded = await loadKey(record.id);
  assert.equal(loaded!.recentIps?.length, 2);
  const ips = new Set(loaded!.recentIps!.map((e) => e.ip));
  assert.ok(ips.has("203.0.113.10"));
  assert.ok(ips.has("198.51.100.7"));

  // Empty/missing IP is a no-op for the ring buffer but still bumps counter.
  const beforeUsage = loaded!.usageCount;
  await recordUse(record.id, "");
  await recordUse(record.id, null);
  loaded = await loadKey(record.id);
  assert.equal(loaded!.recentIps?.length, 2);
  assert.equal(loaded!.usageCount, beforeUsage + 2);

  // Ring buffer is bounded: 6 fresh IPs -> only RECENT_IPS_LIMIT kept,
  // and the most-recently-seen ones survive.
  for (let i = 0; i < RECENT_IPS_LIMIT + 1; i += 1) {
    await recordUse(record.id, `10.0.0.${i + 1}`);
  }
  loaded = await loadKey(record.id);
  assert.ok(loaded!.recentIps!.length <= RECENT_IPS_LIMIT);
  // The very first IP (203.0.113.10) should have been evicted, since the
  // RECENT_IPS_LIMIT + 1 newer distinct IPs were all seen after it.
  assert.ok(!loaded!.recentIps!.some((e) => e.ip === "203.0.113.10"));

  // Summaries surface the same data so the UI can render it.
  const summary = summarize(loaded!);
  assert.ok(Array.isArray(summary.recentIps));
  assert.ok(summary.recentIps!.length <= RECENT_IPS_LIMIT);
  // Sorted newest-first.
  for (let i = 1; i < summary.recentIps!.length; i += 1) {
    assert.ok(summary.recentIps![i - 1].lastSeenAt >= summary.recentIps![i].lastSeenAt);
  }
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

test("api-keys: scopes restrict access and legacy keys keep full access", async () => {
  const { hasScope } = await import("../lib/api-keys.ts");

  // Legacy key (no scopes field) authorizes everything.
  const legacy = await createKey("legacy full");
  const legacyRec = await loadKey(legacy.record.id);
  assert.ok(legacyRec);
  assert.equal(legacyRec!.scopes, undefined);
  assert.equal(hasScope(legacyRec, "compare:write"), true);
  assert.equal(hasScope(legacyRec, "batch:write"), true);

  // Scoped to compare only.
  const compareOnly = await createKey("ci compare", { scopes: ["compare:write"] });
  assert.deepEqual(compareOnly.record.scopes, ["compare:write"]);
  const compareRec = await loadKey(compareOnly.record.id);
  assert.equal(hasScope(compareRec, "compare:write"), true);
  assert.equal(hasScope(compareRec, "batch:write"), false);

  // Garbage/unknown scopes are dropped silently. Empty after filter -> no scopes field.
  const garbage = await createKey("garbage", { scopes: ["nonsense", 42, ""] });
  assert.equal(garbage.record.scopes, undefined);

  // Duplicates collapse and result is sorted.
  const dup = await createKey("dup", {
    scopes: ["batch:write", "compare:write", "batch:write"],
  });
  assert.deepEqual(dup.record.scopes, ["batch:write", "compare:write"]);

  // Null record is unauthorized.
  assert.equal(hasScope(null, "compare:write"), false);
});
