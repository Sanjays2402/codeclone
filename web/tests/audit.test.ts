/**
 * Audit log tests.
 *
 * Verifies append-only behavior, filtering, CSV export, and cross-actor
 * isolation: actor A must not see actor B's entries when filtering by actorId.
 *
 * Run with: node --test --experimental-strip-types web/tests/audit.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-audit-"));
process.env.CODECLONE_AUDIT_DIR = tmp;

const { recordAudit, listAudit, toCsv, tryRecordAudit, AuditError } = await import(
  "../lib/audit.ts"
);

function fakeReq(headers: Record<string, string> = {}): Request {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Request("http://localhost/test", { headers: h });
}

test("audit: rejects invalid action names", async () => {
  await assert.rejects(
    () => recordAudit(fakeReq(), { action: "BadAction" }),
    AuditError,
  );
  await assert.rejects(
    () => recordAudit(fakeReq(), { action: "no_dot" }),
    AuditError,
  );
});

test("audit: records entries with actor, ip, workspace, request id", async () => {
  const entry = await recordAudit(
    fakeReq({
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
      "x-request-id": "req_abc",
      "x-workspace-id": "ws_main",
      "user-agent": "vitest/1.0",
    }),
    {
      action: "snippet.create",
      actorId: "user_alice",
      actorEmail: "alice@example.com",
      target: { type: "snippet", id: "snip_1", label: "hello" },
      diff: { after: { title: "hello" } },
    },
  );
  assert.equal(entry.v, 1);
  assert.equal(entry.actorId, "user_alice");
  assert.equal(entry.workspaceId, "ws_main");
  assert.equal(entry.ip, "203.0.113.7");
  assert.equal(entry.requestId, "req_abc");
  assert.equal(entry.status, "ok");
  assert.ok(typeof entry.id === "string" && entry.id.length > 8);
});

test("audit: cross-actor isolation when filtering by actorId", async () => {
  await recordAudit(fakeReq(), {
    action: "api_key.create",
    actorId: "user_alice",
    actorEmail: "alice@example.com",
    target: { type: "api_key", id: "k1" },
  });
  await recordAudit(fakeReq(), {
    action: "api_key.revoke",
    actorId: "user_bob",
    actorEmail: "bob@example.com",
    target: { type: "api_key", id: "k2" },
  });
  await recordAudit(fakeReq(), {
    action: "api_key.delete",
    actorId: "user_bob",
    actorEmail: "bob@example.com",
    target: { type: "api_key", id: "k3" },
  });

  const aliceOnly = await listAudit({ actorId: "user_alice" });
  assert.ok(aliceOnly.length >= 1);
  for (const e of aliceOnly) {
    assert.equal(e.actorId, "user_alice", "alice query leaked another actor");
  }

  const bobOnly = await listAudit({ actorId: "user_bob" });
  assert.ok(bobOnly.length >= 2);
  for (const e of bobOnly) {
    assert.equal(e.actorId, "user_bob", "bob query leaked another actor");
  }

  // Action-prefix filter
  const keyOps = await listAudit({ action: "api_key." });
  assert.ok(keyOps.every((e) => e.action.startsWith("api_key.")));
});

test("audit: denied entries are recorded and filterable", async () => {
  await recordAudit(fakeReq(), {
    action: "workspace.update",
    actorId: "user_mallory",
    actorEmail: "mallory@example.com",
    workspaceId: "ws_other",
    target: { type: "workspace", id: "ws_other" },
    status: "denied",
  });
  const denied = await listAudit({ status: "denied" });
  assert.ok(denied.some((e) => e.actorId === "user_mallory" && e.action === "workspace.update"));
});

test("audit: tryRecordAudit never throws on invalid input", async () => {
  await tryRecordAudit(fakeReq(), { action: "NOT VALID" });
  // No throw means pass.
  assert.ok(true);
});

test("audit: CSV export contains header and one row per entry", async () => {
  const entries = await listAudit({ limit: 10 });
  const csv = toCsv(entries);
  const lines = csv.split("\n");
  assert.ok(lines[0]!.startsWith("ts,id,actorId"));
  assert.equal(lines.length, entries.length + 1);
});

test("audit: storage is append-only JSONL by UTC day", async () => {
  const files = fs.readdirSync(tmp).filter((f) => f.endsWith(".jsonl"));
  assert.ok(files.length >= 1, "expected at least one daily audit file");
  const raw = fs.readFileSync(path.join(tmp, files[0]!), "utf8");
  const parsed = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { v: number; action: string });
  assert.ok(parsed.length >= 1);
  for (const p of parsed) {
    assert.equal(p.v, 1);
    assert.match(p.action, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/);
  }
});

test("audit: allowedWorkspaceIds enforces cross-tenant isolation", async () => {
  await recordAudit(fakeReq({ "x-workspace-id": "ws_acme" }), {
    action: "snippet.create",
    actorId: "user_alice",
    actorEmail: "alice@example.com",
    target: { type: "snippet", id: "s_acme_1" },
  });
  await recordAudit(fakeReq({ "x-workspace-id": "ws_globex" }), {
    action: "snippet.create",
    actorId: "user_bob",
    actorEmail: "bob@example.com",
    target: { type: "snippet", id: "s_globex_1" },
  });
  // A null-workspace event by alice (e.g. sign-in) should still be visible to alice
  await recordAudit(fakeReq(), {
    action: "session.sign_in",
    actorId: "user_alice",
    actorEmail: "alice@example.com",
    target: { type: "session" },
  });

  // Alice is only a member of ws_acme; she must not see ws_globex entries
  const aliceView = await listAudit({
    allowedWorkspaceIds: new Set(["ws_acme"]),
    selfActorId: "user_alice",
    limit: 500,
  });
  for (const e of aliceView) {
    if (e.workspaceId) {
      assert.equal(e.workspaceId, "ws_acme", "cross-tenant audit leak");
    } else {
      assert.equal(e.actorId, "user_alice", "null-ws entry leaked another actor");
    }
  }
  assert.ok(
    aliceView.some((e) => e.target?.id === "s_acme_1"),
    "alice should see her workspace entry",
  );
  assert.ok(
    !aliceView.some((e) => e.target?.id === "s_globex_1"),
    "alice must not see globex entry",
  );

  // Empty membership = no workspace entries at all
  const stranger = await listAudit({
    allowedWorkspaceIds: new Set<string>(),
    selfActorId: "user_carol",
    limit: 500,
  });
  for (const e of stranger) {
    assert.equal(e.workspaceId, null, "stranger should never see workspace-scoped audit");
    assert.equal(e.actorId, "user_carol");
  }
});
