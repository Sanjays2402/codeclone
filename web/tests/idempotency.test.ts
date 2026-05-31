/**
 * Idempotency-Key support for /v1/compare and /v1/batch.
 *
 * Two layers, mirroring tests/v1-dry-run.test.ts:
 *  1) Unit-test the lib (header parse, body hash stability, fresh vs
 *     replay vs body-conflict vs inflight-conflict).
 *  2) Source-level assertions that both /v1/compare and /v1/batch
 *     actually wire the helper.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

// Sandbox the on-disk store under a temp dir so the suite is hermetic.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-idem-"));
process.env.CODECLONE_IDEMPOTENCY_DIR = tmp;

const mod = await import("../lib/idempotency.ts");
const {
  readIdempotencyKey,
  hashBody,
  begin,
  buildReplay,
  KEY_HEADER,
  REPLAY_HEADER,
  __test,
} = mod;

test("readIdempotencyKey: parses well-formed header", () => {
  const r = new Request("http://x/", { headers: { "Idempotency-Key": "abc-123" } });
  assert.equal(readIdempotencyKey(r), "abc-123");
});

test("readIdempotencyKey: returns null when missing", () => {
  assert.equal(readIdempotencyKey(new Request("http://x/")), null);
});

test("readIdempotencyKey: rejects empty after trim", () => {
  const r = new Request("http://x/", { headers: { "Idempotency-Key": "   " } });
  assert.equal(readIdempotencyKey(r), null);
});

test("readIdempotencyKey: rejects non-ASCII-printable", () => {
  // Tab is a valid HTTP header byte but not in the printable ASCII set.
  const r = new Request("http://x/", { headers: { "Idempotency-Key": "ok\tbad" } });
  assert.equal(readIdempotencyKey(r), null);
});

test("readIdempotencyKey: rejects > 255 chars", () => {
  const big = "a".repeat(256);
  const r = new Request("http://x/", { headers: { "Idempotency-Key": big } });
  assert.equal(readIdempotencyKey(r), null);
});

test("hashBody: stable across key order", () => {
  assert.equal(
    hashBody({ a: 1, b: 2, c: 3 }),
    hashBody({ c: 3, b: 2, a: 1 }),
  );
});

test("hashBody: differs when values differ", () => {
  assert.notEqual(hashBody({ a: 1 }), hashBody({ a: 2 }));
});

test("stableStringify: arrays preserve order", () => {
  assert.notEqual(__test.stableStringify([1, 2]), __test.stableStringify([2, 1]));
});

test("begin: fresh request returns finalize and persists response", async () => {
  const body = { a: "x", b: "y" };
  const r1 = await begin("key_aaa", "idem-1", body);
  assert.equal(r1.kind, "fresh");
  if (r1.kind !== "fresh") return;
  await r1.finalize({ status: 200, contentType: "application/json", body: '{"ok":true}' });

  const r2 = await begin("key_aaa", "idem-1", body);
  assert.equal(r2.kind, "replay");
  if (r2.kind !== "replay") return;
  assert.equal(r2.response.body, '{"ok":true}');
  assert.equal(r2.response.status, 200);
});

test("begin: per-key scope means a different key with same idem key does NOT replay", async () => {
  const body = { a: "x", b: "y" };
  await begin("key_bbb", "shared-idem", body).then((r) =>
    r.kind === "fresh"
      ? r.finalize({ status: 200, contentType: "application/json", body: "1" })
      : null,
  );
  const r = await begin("key_ccc", "shared-idem", body);
  assert.equal(r.kind, "fresh");
});

test("begin: body-mismatch on reuse returns conflict_body", async () => {
  const r1 = await begin("key_ddd", "idem-2", { a: 1 });
  assert.equal(r1.kind, "fresh");
  if (r1.kind !== "fresh") return;
  await r1.finalize({ status: 200, contentType: "application/json", body: "ok" });

  const r2 = await begin("key_ddd", "idem-2", { a: 2 });
  assert.equal(r2.kind, "conflict_body");
});

test("begin: inflight duplicate returns conflict_inflight", async () => {
  const r1 = await begin("key_eee", "idem-3", { a: 1 });
  assert.equal(r1.kind, "fresh");
  // Do NOT call finalize; second begin must see the inflight placeholder.
  const r2 = await begin("key_eee", "idem-3", { a: 1 });
  assert.equal(r2.kind, "conflict_inflight");
});

test("buildReplay: sets content-type, replay header, and live headers", () => {
  const resp = buildReplay(
    { status: 201, contentType: "application/json", body: '{"x":1}' },
    { "x-ratelimit-remaining": "5" },
  );
  assert.equal(resp.status, 201);
  assert.equal(resp.headers.get("content-type"), "application/json");
  assert.equal(resp.headers.get(REPLAY_HEADER), "true");
  assert.equal(resp.headers.get("x-ratelimit-remaining"), "5");
});

test("KEY_HEADER constant matches the documented header name", () => {
  assert.equal(KEY_HEADER, "Idempotency-Key");
});

// ----- Source-level wiring assertions -----

const compareSrc = fs.readFileSync(
  path.join(webRoot, "app/api/v1/compare/route.ts"),
  "utf8",
);
const batchSrc = fs.readFileSync(
  path.join(webRoot, "app/api/v1/batch/route.ts"),
  "utf8",
);

test("/v1/compare imports idempotency helpers", () => {
  assert.match(compareSrc, /from\s+["']\.\.\/\.\.\/\.\.\/\.\.\/lib\/idempotency["']/);
  assert.match(compareSrc, /readIdempotencyKey/);
  assert.match(compareSrc, /idempotencyBegin/);
});

test("/v1/compare handles all four idempotency outcomes", () => {
  assert.match(compareSrc, /conflict_body/);
  assert.match(compareSrc, /conflict_inflight/);
  assert.match(compareSrc, /kind === "replay"/);
  assert.match(compareSrc, /idemFinalize/);
});

test("/v1/compare audits idempotency_conflict events", () => {
  assert.match(compareSrc, /v1\.compare\.idempotency_conflict/);
});

test("/v1/batch imports idempotency helpers", () => {
  assert.match(batchSrc, /from\s+["']\.\.\/\.\.\/\.\.\/\.\.\/lib\/idempotency["']/);
  assert.match(batchSrc, /readIdempotencyKey/);
  assert.match(batchSrc, /idempotencyBegin/);
});

test("/v1/batch handles all four idempotency outcomes", () => {
  assert.match(batchSrc, /conflict_body/);
  assert.match(batchSrc, /conflict_inflight/);
  assert.match(batchSrc, /kind === "replay"/);
  assert.match(batchSrc, /idemFinalize/);
});

test("/v1/batch audits idempotency_conflict events", () => {
  assert.match(batchSrc, /v1\.batch\.idempotency_conflict/);
});

test("idempotency runs AFTER dry_run short-circuit in /v1/compare", () => {
  // Dry-run probes should not lock an idempotency slot, so the begin()
  // call must appear later in the file than the dry-run return.
  const dryIdx = compareSrc.indexOf("if (dryRun)");
  const idemIdx = compareSrc.indexOf("idempotencyBegin(key.id");
  assert.ok(dryIdx > 0, "dry_run branch present");
  assert.ok(idemIdx > 0, "idempotency call present");
  assert.ok(idemIdx > dryIdx, "idempotency must run after the dry_run branch");
});

test("idempotency runs AFTER dry_run short-circuit in /v1/batch", () => {
  const dryIdx = batchSrc.indexOf("if (dryRun)");
  const idemIdx = batchSrc.indexOf("idempotencyBegin(key.id");
  assert.ok(dryIdx > 0);
  assert.ok(idemIdx > 0);
  assert.ok(idemIdx > dryIdx);
});
