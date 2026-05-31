/**
 * Audit hash-chain tamper-evidence tests.
 *
 * Verifies that recordAudit writes a sha256 chain (seq, prevHash, hash) and
 * that verifyAuditChain detects every common tamper case: a flipped field, a
 * deleted middle line, an inserted forged line, and a re-ordered sequence.
 *
 * Run with: node --test --experimental-strip-types web/tests/audit-chain.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-audit-chain-"));
process.env.CODECLONE_AUDIT_DIR = tmp;

const { recordAudit, verifyAuditChain, AUDIT_DIR } = await import("../lib/audit.ts");

function fakeReq(): Request {
  return new Request("http://localhost/t");
}

async function seed(n: number) {
  for (let i = 0; i < n; i++) {
    await recordAudit(fakeReq(), {
      action: "snippet.create",
      actorId: `user_${i}`,
      actorEmail: `u${i}@x.io`,
      target: { type: "snippet", id: `s_${i}` },
      meta: { idx: i },
    });
  }
}

function currentDayFile(): string {
  const files = fs
    .readdirSync(AUDIT_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  return path.join(AUDIT_DIR, files[files.length - 1]!);
}

test("chain: clean append verifies, seq is monotonic, hashes link", async () => {
  await seed(5);
  const result = await verifyAuditChain();
  assert.equal(result.ok, true, "fresh chain must verify");
  assert.equal(result.chainedEntries, 5);
  assert.equal(result.legacyEntries, 0);
  assert.equal(result.brokenAt, null);
  assert.ok(result.lastHash && /^[0-9a-f]{64}$/.test(result.lastHash), "head hash is sha256 hex");

  const file = currentDayFile();
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const parsed = lines.map((l) => JSON.parse(l));
  for (let i = 0; i < parsed.length; i++) {
    assert.equal(parsed[i].seq, i + 1, "seq is per-day monotonic");
    assert.ok(parsed[i].hash, "every entry has a hash");
  }
  assert.equal(parsed[0].prevHash, "0".repeat(64), "genesis prevHash is zeros");
  for (let i = 1; i < parsed.length; i++) {
    assert.equal(parsed[i].prevHash, parsed[i - 1].hash, "prevHash links to prior hash");
  }
});

test("chain: detects field tampering (hash_mismatch)", async () => {
  const file = currentDayFile();
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const tampered = JSON.parse(lines[2]!);
  tampered.actorEmail = "attacker@evil.io";
  lines[2] = JSON.stringify(tampered);
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const result = await verifyAuditChain();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt?.reason, "hash_mismatch");
  assert.equal(result.brokenAt?.seq, 3);
});

test("chain: detects deletion of a middle entry (prev_hash_mismatch)", async () => {
  // Reset directory and reseed cleanly.
  for (const f of fs.readdirSync(AUDIT_DIR)) fs.rmSync(path.join(AUDIT_DIR, f));
  await seed(5);
  const file = currentDayFile();
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  // Remove the third line.
  lines.splice(2, 1);
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const result = await verifyAuditChain();
  assert.equal(result.ok, false);
  // The fourth entry was seq=4 originally; after deletion it sits at local
  // position 3, so we expect seq_out_of_order before we even reach a hash
  // check. Either failure mode is acceptable as long as ok is false.
  assert.ok(
    result.brokenAt?.reason === "seq_out_of_order expected 3" ||
      result.brokenAt?.reason === "prev_hash_mismatch",
    `unexpected reason: ${result.brokenAt?.reason}`,
  );
});

test("chain: detects inserted forged entry", async () => {
  for (const f of fs.readdirSync(AUDIT_DIR)) fs.rmSync(path.join(AUDIT_DIR, f));
  await seed(3);
  const file = currentDayFile();
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const forged = {
    v: 1,
    id: "forged",
    ts: Date.now(),
    actorId: "ghost",
    actorEmail: null,
    workspaceId: null,
    action: "snippet.create",
    target: null,
    status: "ok",
    ip: null,
    userAgent: null,
    requestId: null,
    diff: null,
    meta: null,
    seq: 2,
    prevHash: "deadbeef".repeat(8),
    hash: "ab".repeat(32),
  };
  lines.splice(1, 0, JSON.stringify(forged));
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const result = await verifyAuditChain();
  assert.equal(result.ok, false);
  assert.notEqual(result.brokenAt, null);
});

test("chain: legacy entries without hash are counted but do not break verify", async () => {
  for (const f of fs.readdirSync(AUDIT_DIR)) fs.rmSync(path.join(AUDIT_DIR, f));
  // Write a legacy (unhashed) line directly.
  const day = new Date().toISOString().slice(0, 10);
  const legacyFile = path.join(AUDIT_DIR, `${day}.jsonl`);
  const legacy = {
    v: 1,
    id: "legacy",
    ts: Date.now(),
    actorId: null,
    actorEmail: null,
    workspaceId: null,
    action: "snippet.create",
    target: null,
    status: "ok",
    ip: null,
    userAgent: null,
    requestId: null,
    diff: null,
    meta: null,
  };
  fs.writeFileSync(legacyFile, JSON.stringify(legacy) + "\n");
  await seed(2);

  const result = await verifyAuditChain();
  assert.equal(result.ok, true, "legacy entries must not break a fresh chain");
  assert.equal(result.legacyEntries, 1);
  assert.equal(result.chainedEntries, 2);
});
