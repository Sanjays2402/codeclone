/**
 * Periodic access reviews: lifecycle + cross-tenant isolation.
 *
 * Proves the SOC2 CC6.3 attestation flow end-to-end:
 *   - opening a review snapshots only active members,
 *   - decide() records keep/revoke per member,
 *   - complete() suspends only revoked members,
 *   - sole-owner safety holds (review stays open, suspension is refused),
 *   - reviews are strictly scoped to their workspace directory: a reviewId
 *     from workspace A cannot be loaded via workspace B.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-access-reviews-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");

const ws = await import("../lib/workspaces.ts");
const ar = await import("../lib/access-reviews.ts");

async function seedMember(
  w: Awaited<ReturnType<typeof ws.createWorkspace>>,
  inviterId: string,
  email: string,
  userId: string,
  role: "editor" | "viewer" = "editor",
) {
  const issued = await ws.issueInvite({
    workspace: w,
    email,
    role,
    invitedBy: inviterId,
    origin: "http://localhost:3000",
  });
  await ws.acceptInvite({ token: issued.token, userId, userEmail: email });
}

test("open snapshots active members, decide records, complete suspends revoked", async () => {
  const w = await ws.createWorkspace({
    name: "Acme",
    ownerId: "u_owner0000a01",
    ownerEmail: "owner@acme.test",
  });
  await seedMember(w, "u_owner0000a01", "keep@acme.test", "u_keep00000001", "editor");
  await seedMember(w, "u_owner0000a01", "drop@acme.test", "u_drop00000001", "viewer");

  let fresh = (await ws.getWorkspace(w.id))!;
  const review = await ar.openReview({
    workspace: fresh,
    actorUserId: "u_owner0000a01",
    title: "Q1 review",
  });
  assert.equal(review.status, "open");
  assert.equal(review.entries.length, 3, "owner + two members snapshotted");
  for (const e of review.entries) assert.equal(e.decision, "pending");

  // A second open attempt must conflict.
  await assert.rejects(
    ar.openReview({ workspace: fresh, actorUserId: "u_owner0000a01" }),
    /review_already_open/,
  );

  // Decide everyone.
  await ar.decide({
    workspaceId: w.id,
    reviewId: review.id,
    actorUserId: "u_owner0000a01",
    decisions: [
      { userId: "u_owner0000a01", decision: "keep" },
      { userId: "u_keep00000001", decision: "keep", note: "still active engineer" },
      { userId: "u_drop00000001", decision: "revoke", note: "offboarded" },
    ],
  });

  const result = await ar.complete({
    workspace: fresh,
    reviewId: review.id,
    actorUserId: "u_owner0000a01",
  });
  assert.equal(result.review.status, "completed");
  assert.deepEqual(result.revoked, ["u_drop00000001"]);

  fresh = (await ws.getWorkspace(w.id))!;
  const dropped = ws.getMember(fresh, "u_drop00000001")!;
  assert.equal(dropped.status, "suspended", "revoke decision suspended the member");
  assert.equal(ws.getActiveMember(fresh, "u_drop00000001"), null);
  const kept = ws.getActiveMember(fresh, "u_keep00000001")!;
  assert.equal(kept.status ?? "active", "active", "keep decision left member untouched");
});

test("complete refuses while any decision is pending", async () => {
  const w = await ws.createWorkspace({
    name: "Pending",
    ownerId: "u_owner0000b01",
    ownerEmail: "owner@b.test",
  });
  await seedMember(w, "u_owner0000b01", "x@b.test", "u_b00000000001", "editor");
  const fresh = (await ws.getWorkspace(w.id))!;
  const review = await ar.openReview({ workspace: fresh, actorUserId: "u_owner0000b01" });
  await assert.rejects(
    ar.complete({ workspace: fresh, reviewId: review.id, actorUserId: "u_owner0000b01" }),
    /decisions_incomplete/,
  );
});

test("sole owner cannot be revoked: complete throws, review stays open", async () => {
  const w = await ws.createWorkspace({
    name: "Solo",
    ownerId: "u_solo00000c01",
    ownerEmail: "solo@c.test",
  });
  const fresh = (await ws.getWorkspace(w.id))!;
  const review = await ar.openReview({ workspace: fresh, actorUserId: "u_solo00000c01" });
  await ar.decide({
    workspaceId: w.id,
    reviewId: review.id,
    actorUserId: "u_solo00000c01",
    decisions: [{ userId: "u_solo00000c01", decision: "revoke" }],
  });
  await assert.rejects(
    ar.complete({ workspace: fresh, reviewId: review.id, actorUserId: "u_solo00000c01" }),
    /only_owner/,
  );
  // Sole owner is still active, review is still open.
  const after = (await ws.getWorkspace(w.id))!;
  assert.ok(ws.getActiveMember(after, "u_solo00000c01"), "owner not suspended");
  const reloaded = await ar.getReview(w.id, review.id);
  assert.equal(reloaded?.status, "open", "review stays open so owner can retract");
});

test("reviewId from workspace A cannot be loaded via workspace B", async () => {
  const a = await ws.createWorkspace({
    name: "Tenant A",
    ownerId: "u_a000000000d1",
    ownerEmail: "a@tenant.test",
  });
  const b = await ws.createWorkspace({
    name: "Tenant B",
    ownerId: "u_b000000000d1",
    ownerEmail: "b@tenant.test",
  });
  const aFresh = (await ws.getWorkspace(a.id))!;
  const review = await ar.openReview({ workspace: aFresh, actorUserId: "u_a000000000d1" });

  // Listing tenant B sees no reviews from tenant A.
  const bReviews = await ar.listReviews(b.id);
  assert.equal(bReviews.length, 0, "tenant B sees zero reviews");

  // Direct lookup of A's reviewId against B's workspace returns null
  // (file is read from B's directory only).
  const leak = await ar.getReview(b.id, review.id);
  assert.equal(leak, null, "cross-tenant getReview returns null");

  // decide() against the wrong workspace also cannot mutate A's record.
  await assert.rejects(
    ar.decide({
      workspaceId: b.id,
      reviewId: review.id,
      actorUserId: "u_b000000000d1",
      decisions: [{ userId: "u_a000000000d1", decision: "revoke" }],
    }),
    /not_found/,
  );

  // A's review must remain untouched.
  const aReviewAfter = await ar.getReview(a.id, review.id);
  assert.equal(aReviewAfter?.status, "open");
  for (const e of aReviewAfter!.entries) {
    assert.equal(e.decision, "pending", "no decisions leaked across tenants");
  }
});
