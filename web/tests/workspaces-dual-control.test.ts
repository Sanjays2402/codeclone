/**
 * Dual-control approvals: separation of duties for high-risk workspace
 * actions. Verifies cross-tenant isolation, self-approval rejection,
 * payload binding, single-use semantics, and policy-gated enforcement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-dualctl-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");

const ws = await import("../lib/workspaces.ts");
const dc = await import("../lib/dual-control.ts");

async function writeWorkspace(rec: Awaited<ReturnType<typeof ws.getWorkspace>>) {
  const w = rec!;
  const p = path.join(ws.WORKSPACES_DIR, w.id + ".json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(w, null, 2) + "\n", "utf8");
  await fs.rename(tmp, p);
}

async function seedOwners() {
  const w = await ws.createWorkspace({
    name: "Acme",
    ownerId: "u_alice000001",
    ownerEmail: "alice@example.com",
  });
  // Promote a second owner by transferring then transferring back is
  // overkill; instead inject via the supported role-grant path: invite
  // and then promote.
  const inv = await ws.issueInvite({
    workspace: w,
    email: "bob@example.com",
    role: "editor",
    invitedBy: "u_alice000001",
    origin: "http://localhost:3000",
  });
  await ws.acceptInvite({ token: inv.token, userId: "u_bob000000a", userEmail: "bob@example.com" });
  const fresh = (await ws.getWorkspace(w.id))!;
  const bob = fresh.members.find((m) => m.userId === "u_bob000000a")!;
  bob.role = "owner";
  await writeWorkspace(fresh);
  return (await ws.getWorkspace(w.id))!;
}

test("setDualControlPolicy gates an operation and isDualControlEnabled reflects it", async () => {
  const w = await seedOwners();
  assert.equal(dc.isDualControlEnabled(w, "workspace.wipe"), false);
  await dc.setDualControlPolicy(w, ["workspace.wipe"], "u_alice000001");
  const reloaded = (await ws.getWorkspace(w.id))!;
  assert.equal(dc.isDualControlEnabled(reloaded, "workspace.wipe"), true);
  assert.equal(dc.isDualControlEnabled(reloaded, "workspace.transfer_ownership"), false);
});

test("approval flow: second owner approves, token is one-shot, payload-bound", async () => {
  const w = await seedOwners();
  await dc.setDualControlPolicy(w, ["workspace.wipe"], "u_alice000001");

  const req = await dc.createApprovalRequest({
    workspaceId: w.id,
    operation: "workspace.wipe",
    payload: { confirm: w.slug },
    reason: "Decommissioning per ticket SEC-204",
    requestedBy: "u_alice000001",
    requestedByEmail: "alice@example.com",
  });
  assert.equal(req.status, "pending");

  await assert.rejects(
    () =>
      dc.approveRequest({
        workspaceId: w.id,
        approvalId: req.id,
        approverUserId: "u_alice000001",
        approverEmail: "alice@example.com",
      }),
    /self_approval_forbidden/,
  );

  const { token } = await dc.approveRequest({
    workspaceId: w.id,
    approvalId: req.id,
    approverUserId: "u_bob000000a",
    approverEmail: "bob@example.com",
  });
  assert.ok(token && token.length > 20, "token is returned exactly once");

  // Payload tamper: an approval for `confirm:w.slug` must not consume
  // against a different payload (defends against bait-and-switch).
  await assert.rejects(
    () =>
      dc.consumeApprovalToken({
        workspaceId: w.id,
        operation: "workspace.wipe",
        token,
        payloadForHash: { confirm: "some-other-slug" },
      }),
    /payload_mismatch/,
  );

  const consumed = await dc.consumeApprovalToken({
    workspaceId: w.id,
    operation: "workspace.wipe",
    token,
    payloadForHash: { confirm: w.slug },
  });
  assert.equal(consumed.status, "consumed");

  // Single-use: replay must fail.
  await assert.rejects(
    () =>
      dc.consumeApprovalToken({
        workspaceId: w.id,
        operation: "workspace.wipe",
        token,
        payloadForHash: { confirm: w.slug },
      }),
    /token_invalid/,
  );
});

test("cross-tenant isolation: a token issued in workspace A cannot be consumed in workspace B", async () => {
  const a = await seedOwners();
  const b = await ws.createWorkspace({
    name: "Other Corp",
    ownerId: "u_carol000001",
    ownerEmail: "carol@example.com",
  });
  // Mirror the same slug across workspaces so payload hash collides if
  // someone forgets to scope by workspaceId. The test then proves the
  // workspaceId is what actually isolates.
  const aFresh = (await ws.getWorkspace(a.id))!;
  aFresh.slug = "shared-slug";
  await writeWorkspace(aFresh);
  const bFresh = (await ws.getWorkspace(b.id))!;
  bFresh.slug = "shared-slug";
  await writeWorkspace(bFresh);

  await dc.setDualControlPolicy(aFresh, ["workspace.wipe"], "u_alice000001");
  await dc.setDualControlPolicy(bFresh, ["workspace.wipe"], "u_carol000001");

  const req = await dc.createApprovalRequest({
    workspaceId: aFresh.id,
    operation: "workspace.wipe",
    payload: { confirm: "shared-slug" },
    reason: "tenant-A approval",
    requestedBy: "u_alice000001",
    requestedByEmail: "alice@example.com",
  });
  const { token } = await dc.approveRequest({
    workspaceId: aFresh.id,
    approvalId: req.id,
    approverUserId: "u_bob000000a",
    approverEmail: "bob@example.com",
  });

  // Same operation, same payload, valid token -- but wrong workspace.
  // Must be rejected: approvals live under per-workspace directories.
  await assert.rejects(
    () =>
      dc.consumeApprovalToken({
        workspaceId: bFresh.id,
        operation: "workspace.wipe",
        token,
        payloadForHash: { confirm: "shared-slug" },
      }),
    /token_invalid/,
    "token from workspace A must not work in workspace B",
  );

  // listApprovals must be strictly workspace-scoped.
  const aList = await dc.listApprovals(aFresh.id);
  const bList = await dc.listApprovals(bFresh.id);
  assert.equal(aList.length, 1);
  assert.equal(bList.length, 0);
});

test("cancel invalidates an approved token before it is consumed", async () => {
  const w = await seedOwners();
  await dc.setDualControlPolicy(w, ["workspace.transfer_ownership"], "u_alice000001");
  const req = await dc.createApprovalRequest({
    workspaceId: w.id,
    operation: "workspace.transfer_ownership",
    payload: { toUserId: "u_bob000000a" },
    reason: "hand over to bob",
    requestedBy: "u_alice000001",
    requestedByEmail: "alice@example.com",
  });
  const { token } = await dc.approveRequest({
    workspaceId: w.id,
    approvalId: req.id,
    approverUserId: "u_bob000000a",
    approverEmail: "bob@example.com",
  });
  await dc.cancelRequest({ workspaceId: w.id, approvalId: req.id, byUserId: "u_alice000001" });
  await assert.rejects(
    () =>
      dc.consumeApprovalToken({
        workspaceId: w.id,
        operation: "workspace.transfer_ownership",
        token,
        payloadForHash: { toUserId: "u_bob000000a" },
      }),
    /token_invalid/,
  );
});
