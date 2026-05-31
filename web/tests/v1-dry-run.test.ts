/**
 * Run with: node --test --experimental-strip-types web/tests/v1-dry-run.test.ts
 *
 * Tests for the /v1 sandbox / dry-run mode. The route handlers themselves
 * import next/server and cannot be loaded under raw `node --test`, so we
 * cover the contract in two layers:
 *
 *   1) Unit-test the `isDryRun` helper across the documented input shapes
 *      (query string, body field, common truthy strings, negative cases).
 *   2) Source-level assertions that both /v1/compare and /v1/batch routes
 *      actually wire the helper AND short-circuit the side-effect calls
 *      (`recordUse`, `logUsage`, `dispatchEvent`) when dry-run is true,
 *      and that they still record an audit entry tagged `*.dry_run`.
 *
 * Together these guarantee dry-run remains a real no-op preview: any
 * regression that drops the helper, drops the audit, or fires a webhook
 * on a dry-run will fail this test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const { isDryRun, DRY_RUN_HEADER } = await import("../lib/dry-run.ts");

test("isDryRun: detects dry_run=true via query string", () => {
  assert.equal(isDryRun(new Request("http://x/?dry_run=true"), {}), true);
  assert.equal(isDryRun(new Request("http://x/?dry_run=1"), {}), true);
  assert.equal(isDryRun(new Request("http://x/?dry_run=yes"), {}), true);
  assert.equal(isDryRun(new Request("http://x/?dry_run=TRUE"), {}), true);
});

test("isDryRun: detects dry_run via JSON body field", () => {
  assert.equal(isDryRun(new Request("http://x/"), { dry_run: true }), true);
  assert.equal(isDryRun(new Request("http://x/"), { dry_run: "yes" }), true);
  assert.equal(isDryRun(new Request("http://x/"), { dry_run: "1" }), true);
});

test("isDryRun: returns false when missing or falsy", () => {
  assert.equal(isDryRun(new Request("http://x/"), {}), false);
  assert.equal(isDryRun(new Request("http://x/"), null), false);
  assert.equal(isDryRun(new Request("http://x/?dry_run=no"), {}), false);
  assert.equal(isDryRun(new Request("http://x/?dry_run=0"), {}), false);
  assert.equal(isDryRun(new Request("http://x/"), { dry_run: false }), false);
  assert.equal(isDryRun(new Request("http://x/"), { dry_run: "anything-else" }), false);
});

test("DRY_RUN_HEADER: emits the documented response header", () => {
  assert.deepEqual(DRY_RUN_HEADER, { "x-codeclone-dry-run": "true" });
});

const compareSrc = fs.readFileSync(
  path.join(webRoot, "app/api/v1/compare/route.ts"),
  "utf8",
);
const batchSrc = fs.readFileSync(
  path.join(webRoot, "app/api/v1/batch/route.ts"),
  "utf8",
);

function dryRunBlock(src: string): string {
  // Grab the contents of the `if (dryRun) { ... }` block so we can
  // assert what is and is not inside it.
  const m = src.match(/if \(dryRun\) \{([\s\S]*?)\n  \}/);
  if (!m) throw new Error("no `if (dryRun)` block found in route source");
  return m[1];
}

test("v1/compare route: wires isDryRun and short-circuits writes", () => {
  assert.match(compareSrc, /import \{ isDryRun, DRY_RUN_HEADER \} from .*dry-run/);
  assert.match(compareSrc, /const dryRun = isDryRun\(req, raw\);/);

  const block = dryRunBlock(compareSrc);
  // Must NOT call the live side-effects inside the dry-run branch.
  assert.ok(!block.includes("recordUse("), "dry-run must not call recordUse");
  assert.ok(!block.includes("logUsage("), "dry-run must not call logUsage");
  assert.ok(
    !block.includes("dispatchEvent("),
    "dry-run must not call dispatchEvent (webhook fan-out)",
  );
  // Must still audit and must emit the dry-run header.
  assert.match(block, /action: "v1\.compare\.dry_run"/);
  assert.ok(block.includes("DRY_RUN_HEADER"));
  // Must return dry_run: true in the response body.
  assert.match(block, /dry_run: true/);
});

test("v1/batch route: wires isDryRun and short-circuits writes", () => {
  assert.match(batchSrc, /import \{ isDryRun, DRY_RUN_HEADER \} from .*dry-run/);
  assert.match(batchSrc, /const dryRun = isDryRun\(req, raw\);/);

  const block = dryRunBlock(batchSrc);
  assert.ok(!block.includes("recordUse("), "dry-run must not call recordUse");
  assert.ok(!block.includes("logUsage("), "dry-run must not call logUsage");
  assert.ok(
    !block.includes("dispatchEvent("),
    "dry-run must not call dispatchEvent (webhook fan-out)",
  );
  assert.match(block, /action: "v1\.batch\.dry_run"/);
  assert.ok(block.includes("DRY_RUN_HEADER"));
  assert.match(block, /dry_run: true/);
  // Pair count preview is what makes batch dry-run useful for sizing calls.
  assert.match(block, /pair_count/);
});

test("v1 GET self-description advertises dry_run on both endpoints", () => {
  assert.match(compareSrc, /dry_run: "boolean \(optional\)/);
  assert.match(batchSrc, /dry_run: "boolean \(optional\)/);
});
