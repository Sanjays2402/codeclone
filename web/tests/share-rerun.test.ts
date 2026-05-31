/**
 * Re-run contract: a saved share must expose enough data via loadShare()
 * to fully re-populate the compare page (left snippet, right snippet,
 * language). This is what /compare?from=<id> relies on.
 *
 * Run with the rest of the suite via `pnpm test`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-rerun-"));
process.env.CODECLONE_SHARES_DIR = tmp;

const { createShare, loadShare } = await import("../lib/share.ts");

function fakeResult(): any {
  return {
    language: "python",
    scores: { shingleJaccard: 0.81, tokenJaccard: 0.74, containment: 0.9 },
    alignment: { rows: [] },
    clone: {
      label: "near-clone" as const,
      type: "type-2" as const,
      confidence: 0.8,
      rationale: "test",
    },
    bytes: { a: 12, b: 12 },
    latency_ms: 3,
    method: "test",
  };
}

test("share record round-trips snippets and language for re-run", async () => {
  const a = "def add(x, y):\n    return x + y\n";
  const b = "def sum2(p, q):\n    return p + q\n";
  const rec = await createShare({
    a,
    b,
    language: "python",
    result: fakeResult(),
    title: "adder vs sum2",
  });

  const loaded = await loadShare(rec.id);
  assert.ok(loaded, "share should load by id");
  assert.equal(loaded!.a, a, "left snippet must round-trip");
  assert.equal(loaded!.b, b, "right snippet must round-trip");
  assert.equal(loaded!.language, "python", "language must round-trip");
  assert.equal(loaded!.title, "adder vs sum2");
});

test("share record exposes language field even for minimal saves", async () => {
  const rec = await createShare({
    a: "x=1",
    b: "y=2",
    language: "javascript",
    result: fakeResult(),
  });
  const loaded = await loadShare(rec.id);
  assert.ok(loaded);
  // These three fields are the re-run contract surface. If any of them
  // disappears, /compare?from=<id> silently falls back to empty editors.
  assert.equal(typeof loaded!.a, "string");
  assert.equal(typeof loaded!.b, "string");
  assert.equal(typeof loaded!.language, "string");
});
