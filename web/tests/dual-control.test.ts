/**
 * Dual-control approvals — store-level proofs.
 *
 * Run with:
 *   cd web && node --test --experimental-strip-types tests/dual-control.test.ts
 *
 * What this protects against
 * --------------------------
 *   - Self-approval (requester approves their own request).
 *   - Cross-tenant approval reuse (a token minted in workspace A is
 *     presented to workspace B's destructive call).
 *   - Bait-and-switch payload (approval issued for one payload is
 *     consumed against a different payload).
 *   - Token replay (a successful consume is one-shot).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-dc-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_APPROVALS_DIR = path.join(tmp, "approvals");

const ws = await import("../lib/workspaces.ts");
const dc = await import("../lib/dual-control.ts");

async function seedOwner(
  w: Awaited<ReturnType<typeof ws.createWorkspace>>,
  inviterId: string,
  email: string,
  userId: string,
) {
  const issued = await ws.issueInvite({
    workspace: w,
    email,
    role: "editor",
    invitedBy: inviterId,
    origin: "http://localhost:3000",
  });
  await ws.acceptInvite({ token: issued.token, userId, userEmail: email });
  const fresh = (await ws.getWorkspace(w.id))!;
  await ws.setMemberRole(fresh, inviterId, userId, "owner");
}

test("dual-control: policy save and read round-trip", async () => {
  const w = await ws.createWorkspace({
    name: "DC One",
    ownerId: "u_alice00001",
    ownerEmail: "alice@example.com",
  });
  await dc.setDualControlPolicy(w, ["workspace.wipe"], "u_alice00001");
  const reloaded = (await ws.getWorkspace(w.id))!;
  assert.deepEqual(dc.getDualControlPolicy(reloaded)?.operations, ["workspace.wipe"]);
  assert.equal(dc.isDualControlEnabled(reloaded, "workspace.wipe"), true);
  assert.equal(dc.isDualControlEnabled(reloaded, "workspace.transfer_ownership"), false);
});

test("dual-control: self-approval is refused", async () => {
  const w = await ws.createWorkspace({
    name: "DC Self",
    ownerId: "u_self0000001",
    ownerEmail: "self@example.com",
  });
  const req = await dc.createApprovalRequest({
    workspaceId: w.id,
    operation: "workspace.wipe",
    payload: { confirm: w.slug },
    reason: "quarterly destruction",
    requestedBy: "u_self0000001",
    requestedByEmail: "self@example.com",
  });
  await assert.rejects(
    () =>
      dc.approveRequest({
        workspaceId: w.id,
        approvalId: req.id,
        approverUserId: "u_self0000001",
        approverEmail: "self@example.com",
      }),
    /self_approval_forbidden/,
  );
});

test("dual-control: token consumed once cannot be replayed", async () => {
  const w = await ws.createWorkspace({
    name: "DC Replay",
    ownerId: "u_r1",
    ownerEmail: "r1@example.com",
  });
  await seedOwner(w, "u_r1", "r2@example.com", "u_r2");
  const fresh = (await ws.getWorkspace(w.id))!;
  const req = await dc.createApprovalRequest({
    workspaceId: fresh.id,
    operation: "workspace.wipe",
    payload: { confirm: fresh.slug },
    reason: "purge stale tenant data",
    requestedBy: "u_r1",
    requestedByEmail: "r1@example.com",
  });
  const { token } = await dc.approveRequest({
    workspaceId: fresh.id,
    approvalId: req.id,
    approverUserId: "u_r2",
    approverEmail: "r2@example.com",
  });
  // First consume succeeds.
  await dc.consumeApprovalToken({
    workspaceId: fresh.id,
    operation: "workspace.wipe",
    token,
    payloadForHash: { confirm: fresh.slug },
  });
  // Second consume must be refused.
  await assert.rejects(
    () =>
      dc.consumeApprovalToken({
        workspaceId: fresh.id,
        operation: "workspace.wipe",
        token,
        payloadForHash: { confirm: fresh.slug },
      }),
    /token_invalid/,
  );
});

test("dual-control: cross-tenant token reuse is refused", async () => {
  // Two independent workspaces. A valid token for workspace A must NOT
  // be accepted when presented to workspace B's destructive endpoint.
  const a = await ws.createWorkspace({
    name: "Tenant A",
    ownerId: "u_aOwner001",
    ownerEmail: "a-owner@example.com",
  });
  await seedOwner(a, "u_aOwner001", "a-second@example.com", "u_aSecond01");
  const aFresh = (await ws.getWorkspace(a.id))!;

  const b = await ws.createWorkspace({
    name: "Tenant B",
    ownerId: "u_bOwner001",
    ownerEmail: "b-owner@example.com",
  });

  const req = await dc.createApprovalRequest({
    workspaceId: aFresh.id,
    operation: "workspace.wipe",
    payload: { confirm: aFresh.slug },
    reason: "GDPR contract termination",
    requestedBy: "u_aOwner001",
    requestedByEmail: "a-owner@example.com",
  });
  const { token } = await dc.approveRequest({
    workspaceId: aFresh.id,
    approvalId: req.id,
    approverUserId: "u_aSecond01",
    approverEmail: "a-second@example.com",
  });
  // Try consuming against tenant B's workspace.
  await assert.rejects(
    () =>
      dc.consumeApprovalToken({
        workspaceId: b.id,
        operation: "workspace.wipe",
        token,
        payloadForHash: { confirm: b.slug },
      }),
    /token_invalid/,
    "token from tenant A must not authorize a wipe in tenant B",
  );
  // And the listing surface must keep approvals isolated.
  const aList = await dc.listApprovals(aFresh.id);
  const bList = await dc.listApprovals(b.id);
  assert.equal(aList.length, 1);
  assert.equal(bList.length, 0);
});

test("dual-control: payload bait-and-switch is refused", async () => {
  const w = await ws.createWorkspace({
    name: "DC BaitSwap",
    ownerId: "u_x1",
    ownerEmail: "x1@example.com",
  });
  await seedOwner(w, "u_x1", "x2@example.com", "u_x2");
  await seedOwner(w, "u_x1", "victim@example.com", "u_victim001");
  const fresh = (await ws.getWorkspace(w.id))!;
  // Request approval for transferring ownership to u_x2.
  const req = await dc.createApprovalRequest({
    workspaceId: fresh.id,
    operation: "workspace.transfer_ownership",
    payload: { toUserId: "u_x2" },
    reason: "Alice rotating out",
    requestedBy: "u_x1",
    requestedByEmail: "x1@example.com",
  });
  const { token } = await dc.approveRequest({
    workspaceId: fresh.id,
    approvalId: req.id,
    approverUserId: "u_victim001",
    approverEmail: "victim@example.com",
  });
  // Attacker tries to spend it on a transfer to themselves.
  await assert.rejects(
    () =>
      dc.consumeApprovalToken({
        workspaceId: fresh.id,
        operation: "workspace.transfer_ownership",
        token,
        payloadForHash: { toUserId: "u_attacker0" },
      }),
    /payload_mismatch/,
  );
});

test("dual-control: cancelled approvals cannot be consumed", async () => {
  const w = await ws.createWorkspace({
    name: "DC Cancel",
    ownerId: "u_c1",
    ownerEmail: "c1@example.com",
  });
  await seedOwner(w, "u_c1", "c2@example.com", "u_c2");
  const fresh = (await ws.getWorkspace(w.id))!;
  const req = await dc.createApprovalRequest({
    workspaceId: fresh.id,
    operation: "workspace.wipe",
    payload: { confirm: fresh.slug },
    reason: "test",
    requestedBy: "u_c1",
    requestedByEmail: "c1@example.com",
  });
  const { token } = await dc.approveRequest({
    workspaceId: fresh.id,
    approvalId: req.id,
    approverUserId: "u_c2",
    approverEmail: "c2@example.com",
  });
  await dc.cancelRequest({
    workspaceId: fresh.id,
    approvalId: req.id,
    byUserId: "u_c1",
  });
  // A cancelled approval clears the approved-state filter inside the
  // consume loop, so the token is no longer accepted.
  await assert.rejects(
    () =>
      dc.consumeApprovalToken({
        workspaceId: fresh.id,
        operation: "workspace.wipe",
        token,
        payloadForHash: { confirm: fresh.slug },
      }),
    /token_invalid/,
  );
});
