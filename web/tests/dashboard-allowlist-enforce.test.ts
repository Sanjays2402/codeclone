/**
 * Dashboard / session-authenticated IP allowlist enforcement.
 *
 * Verifies:
 *   - A workspace with an empty allowlist is open (returns null).
 *   - A request from an IP outside the allowlist is blocked with 403 and
 *     a structured `ip_not_allowed` payload.
 *   - A request from an IP inside the allowlist is allowed.
 *   - `bypass: true` (the lockout-safety escape used by the allowlist edit
 *     endpoint itself) always allows, even when the IP is outside.
 *   - Cross-tenant isolation: two workspaces with different allowlists
 *     do not bleed; each is evaluated against its own list.
 *   - A block writes a `workspace.ip_block` audit entry tagged
 *     `channel: "dashboard"`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codeclone-dashgate-"));
process.env.CODECLONE_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CODECLONE_AUDIT_DIR = path.join(tmp, "audit");
process.env.CODECLONE_AUTH_SECRET = "test-secret-for-dashboard-allowlist";

const ws = await import("../lib/workspaces.ts");
const gate = await import("../lib/dashboard-allowlist-enforce.ts");
const audit = await import("../lib/audit.ts");

function req(ip: string): Request {
  return new Request("https://example.test/api/workspaces/x", {
    method: "GET",
    headers: { "x-forwarded-for": ip },
  });
}

const ACTOR = { id: "u_dashowner0001", email: "owner@example.com" };

test("empty allowlist is open: gate returns null", async () => {
  const w = await ws.createWorkspace({
    name: "Open workspace",
    ownerId: ACTOR.id,
    ownerEmail: ACTOR.email,
  });
  const res = await gate.enforceWorkspaceAllowlistForSession(req("203.0.113.9"), w, ACTOR, {
    surface: "workspaces/test",
  });
  assert.equal(res, null);
});

test("request outside allowlist is blocked with 403 ip_not_allowed", async () => {
  const w = await ws.createWorkspace({
    name: "Pinned workspace",
    ownerId: ACTOR.id,
    ownerEmail: ACTOR.email,
  });
  const pinned = await ws.setIpAllowlist(w, ["10.0.0.0/8"]);
  const res = await gate.enforceWorkspaceAllowlistForSession(req("203.0.113.9"), pinned, ACTOR, {
    surface: "workspaces/test",
  });
  assert.ok(res, "expected a blocking response");
  assert.equal(res!.status, 403);
  const body = await res!.json();
  assert.equal(body.error.type, "ip_not_allowed");
  assert.equal(body.error.ip, "203.0.113.9");
});

test("request inside allowlist is allowed", async () => {
  const w = await ws.createWorkspace({
    name: "Pinned workspace 2",
    ownerId: ACTOR.id,
    ownerEmail: ACTOR.email,
  });
  const pinned = await ws.setIpAllowlist(w, ["10.0.0.0/8"]);
  const res = await gate.enforceWorkspaceAllowlistForSession(req("10.1.2.3"), pinned, ACTOR, {
    surface: "workspaces/test",
  });
  assert.equal(res, null);
});

test("bypass: true always allows (lockout safety on allowlist edit endpoint)", async () => {
  const w = await ws.createWorkspace({
    name: "Bypass workspace",
    ownerId: ACTOR.id,
    ownerEmail: ACTOR.email,
  });
  const pinned = await ws.setIpAllowlist(w, ["10.0.0.0/8"]);
  const res = await gate.enforceWorkspaceAllowlistForSession(req("198.51.100.7"), pinned, ACTOR, {
    surface: "workspaces/allowlist",
    bypass: true,
  });
  assert.equal(
    res,
    null,
    "owner editing the allowlist must never be locked out, even from an off-list IP",
  );
});

test("cross-tenant isolation: workspace A allowlist does not gate workspace B", async () => {
  const a = await ws.createWorkspace({ name: "Tenant A", ownerId: ACTOR.id, ownerEmail: ACTOR.email });
  const b = await ws.createWorkspace({ name: "Tenant B", ownerId: ACTOR.id, ownerEmail: ACTOR.email });
  const aPinned = await ws.setIpAllowlist(a, ["10.0.0.0/8"]); // strict
  // B has no allowlist; a request from B's user from 203.0.113.0 must succeed
  // even though that IP would be blocked by A's allowlist.
  const blockedOnA = await gate.enforceWorkspaceAllowlistForSession(
    req("203.0.113.9"),
    aPinned,
    ACTOR,
    { surface: "workspaces/test" },
  );
  assert.ok(blockedOnA, "request from 203.0.113.9 must be blocked on tenant A");
  const allowedOnB = await gate.enforceWorkspaceAllowlistForSession(req("203.0.113.9"), b, ACTOR, {
    surface: "workspaces/test",
  });
  assert.equal(allowedOnB, null, "tenant B has no allowlist; request must pass");
});

test("block writes a workspace.ip_block audit entry tagged channel:dashboard", async () => {
  const w = await ws.createWorkspace({
    name: "Audit workspace",
    ownerId: ACTOR.id,
    ownerEmail: ACTOR.email,
  });
  const pinned = await ws.setIpAllowlist(w, ["10.0.0.0/8"]);
  const res = await gate.enforceWorkspaceAllowlistForSession(req("198.51.100.4"), pinned, ACTOR, {
    surface: "workspaces/members",
  });
  assert.ok(res);
  // Pull the most recent audit entries for this workspace.
  const entries = await audit.listAudit({ limit: 50 });
  const hit = entries.find(
    (e) => e.action === "workspace.ip_block" && e.workspaceId === w.id && (e.meta as { channel?: string } | null)?.channel === "dashboard",
  );
  assert.ok(hit, "expected a workspace.ip_block audit entry with channel:dashboard");
  assert.equal(hit!.status, "denied");
  assert.equal(hit!.actorId, ACTOR.id);
});
