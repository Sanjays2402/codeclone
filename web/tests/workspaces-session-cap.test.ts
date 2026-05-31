/**
 * Workspace concurrent-session cap enforcement.
 *
 * Verifies:
 *   - sanitizeSessionPolicy clamps maxConcurrentSessions to bounds and
 *     defaults missing values to 0 (back-compat with older bodies).
 *   - setSessionPolicy persists the cap and clears when all values are 0.
 *   - effectiveSessionPolicyForUser picks the strictest non-zero cap
 *     across only the workspaces a user is an active member of, and
 *     ignores workspaces they were never a member of (cross-tenant
 *     isolation).
 *   - enforceConcurrentSessionCap revokes the oldest sessions and keeps
 *     the just-issued one; never touches another user's sessions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-sc-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_USERS_DIR = path.join(tmp, "users");
process.env.CODECLONE_SESSIONS_DIR = path.join(tmp, "sessions");
process.env.CODECLONE_AUTH_LINKS_DIR = path.join(tmp, "links");
process.env.CODECLONE_AUDIT_DIR = path.join(tmp, "audit");
process.env.CODECLONE_AUTH_SECRET = "test-secret-for-session-cap";

const ws = await import("../lib/workspaces.ts");
const sessions = await import("../lib/sessions.ts");

test("sanitizeSessionPolicy clamps maxConcurrentSessions and defaults to 0", () => {
  const lo = ws.sanitizeSessionPolicy({
    maxLifetimeSec: 0,
    idleTimeoutSec: 0,
    maxConcurrentSessions: -5,
  });
  assert.ok(lo);
  assert.equal(lo!.maxConcurrentSessions, 0, "negative collapses to 0");

  const hi = ws.sanitizeSessionPolicy({
    maxLifetimeSec: 0,
    idleTimeoutSec: 0,
    maxConcurrentSessions: 9999,
  });
  assert.ok(hi);
  assert.equal(
    hi!.maxConcurrentSessions,
    ws.SESSION_POLICY_BOUNDS.maxConcurrentSessions.max,
  );

  const sub = ws.sanitizeSessionPolicy({
    maxLifetimeSec: 0,
    idleTimeoutSec: 0,
    maxConcurrentSessions: 0.4,
  });
  assert.ok(sub);
  assert.equal(
    sub!.maxConcurrentSessions,
    0,
    "fractional <1 collapses to 0 (no cap)",
  );

  const missing = ws.sanitizeSessionPolicy({ maxLifetimeSec: 0, idleTimeoutSec: 0 });
  assert.ok(missing);
  assert.equal(missing!.maxConcurrentSessions, 0, "absent field stays 0");
});

test("setSessionPolicy persists the cap and clears on all-zero", async () => {
  const w = await ws.createWorkspace({
    name: "Cap team",
    ownerId: "u_owner0capx01",
    ownerEmail: "owner@example.com",
  });
  const after = await ws.setSessionPolicy(
    w,
    { maxLifetimeSec: 0, idleTimeoutSec: 0, maxConcurrentSessions: 3 },
    "u_owner0capx01",
  );
  assert.equal(after.sessionPolicy?.maxConcurrentSessions, 3);
  const reread = await ws.getWorkspace(w.id);
  assert.equal(reread?.sessionPolicy?.maxConcurrentSessions, 3);

  const cleared = await ws.setSessionPolicy(
    reread!,
    { maxLifetimeSec: 0, idleTimeoutSec: 0, maxConcurrentSessions: 0 },
    "u_owner0capx01",
  );
  assert.equal(cleared.sessionPolicy, null, "all-zero policy is cleared");
});

test("effectiveSessionPolicyForUser picks strictest cap and isolates by membership", async () => {
  const alice = "u_alicec000001";
  const bob = "u_bobcap000001";
  const w1 = await ws.createWorkspace({
    name: "Alice 1",
    ownerId: alice,
    ownerEmail: "a@example.com",
  });
  const w2 = await ws.createWorkspace({
    name: "Alice 2",
    ownerId: alice,
    ownerEmail: "a@example.com",
  });
  const w3 = await ws.createWorkspace({
    name: "Bob only",
    ownerId: bob,
    ownerEmail: "b@example.com",
  });
  await ws.setSessionPolicy(
    w1,
    { maxLifetimeSec: 0, idleTimeoutSec: 0, maxConcurrentSessions: 5 },
    alice,
  );
  await ws.setSessionPolicy(
    w2,
    { maxLifetimeSec: 0, idleTimeoutSec: 0, maxConcurrentSessions: 2 },
    alice,
  );
  // A very tight cap on a workspace Alice is NOT a member of must never
  // reach her: cross-tenant isolation.
  await ws.setSessionPolicy(
    w3,
    { maxLifetimeSec: 0, idleTimeoutSec: 0, maxConcurrentSessions: 1 },
    bob,
  );

  const effAlice = await ws.effectiveSessionPolicyForUser(alice);
  assert.equal(effAlice.maxConcurrentSessions, 2, "strictest of Alice's two policies");
  assert.equal(effAlice.capSourceWorkspaceId, w2.id);

  const effBob = await ws.effectiveSessionPolicyForUser(bob);
  assert.equal(effBob.maxConcurrentSessions, 1, "Bob sees his own workspace");

  const effLonely = await ws.effectiveSessionPolicyForUser("u_nobody0cap01");
  assert.equal(effLonely.maxConcurrentSessions, 0, "non-member has no cap");
});

test("enforceConcurrentSessionCap revokes oldest, preserves keepJti, isolates by user", async () => {
  const alice = "u_alicecap0002";
  const bob = "u_bobcap000002";

  // Create 4 active sessions for Alice with monotonically increasing
  // createdAt so the eviction order is deterministic.
  const aliceJtis: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const jti = sessions.newJti();
    aliceJtis.push(jti);
    const rec = await sessions.createSession({
      userId: alice,
      jti,
      ttlSec: 60 * 60,
      ip: `10.0.0.${i + 1}`,
      userAgent: `ua-${i}`,
    });
    // Pin createdAt deterministically and persist.
    rec.createdAt = 1_000_000 + i * 1000;
    rec.lastSeenAt = rec.createdAt;
    await fs.writeFile(
      path.join(
        process.env.CODECLONE_SESSIONS_DIR!,
        encodeURIComponent(alice),
        `${jti}.json`,
      ),
      JSON.stringify(rec) + "\n",
      "utf8",
    );
  }

  // Bob has his own session that must never be touched by Alice's cap.
  const bobJti = sessions.newJti();
  await sessions.createSession({
    userId: bob,
    jti: bobJti,
    ttlSec: 60 * 60,
    ip: null,
    userAgent: null,
  });

  // Cap Alice at 2, keep the newest (last jti we created).
  const keep = aliceJtis[aliceJtis.length - 1];
  const evicted = await sessions.enforceConcurrentSessionCap(alice, 2, keep);
  assert.equal(evicted.length, 2, "evicted oldest two");
  const evictedJtis = new Set(evicted.map((e) => e.jti));
  assert.ok(evictedJtis.has(aliceJtis[0]), "oldest evicted");
  assert.ok(evictedJtis.has(aliceJtis[1]), "second oldest evicted");
  assert.ok(!evictedJtis.has(keep), "keep jti preserved");

  const remaining = await sessions.listSessions(alice);
  assert.equal(remaining.length, 2, "Alice is at the cap");
  const remainingJtis = new Set(remaining.map((s) => s.jti));
  assert.ok(remainingJtis.has(keep));
  assert.ok(remainingJtis.has(aliceJtis[2]));

  // Cross-tenant isolation: Bob's session is untouched.
  const bobSessions = await sessions.listSessions(bob);
  assert.equal(bobSessions.length, 1);
  assert.equal(bobSessions[0].jti, bobJti);

  // cap=0 is a no-op even with many sessions.
  const noop = await sessions.enforceConcurrentSessionCap(alice, 0, keep);
  assert.equal(noop.length, 0);

  // cap >= active count is a no-op.
  const noop2 = await sessions.enforceConcurrentSessionCap(alice, 10, keep);
  assert.equal(noop2.length, 0);
});
