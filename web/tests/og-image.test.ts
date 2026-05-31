import test from "node:test";
import assert from "node:assert/strict";
import {
  OG_SIZE,
  OG_CONTENT_TYPE,
  OG_RUNTIME,
  OG_ALT,
  pctColor,
  fmtBytes,
  fmtPct,
} from "../lib/og-share.ts";

test("OG metadata constants match Twitter summary_large_image spec", () => {
  assert.deepEqual(OG_SIZE, { width: 1200, height: 630 });
  assert.equal(OG_CONTENT_TYPE, "image/png");
  assert.equal(OG_RUNTIME, "nodejs");
  assert.ok(OG_ALT.length > 0 && !OG_ALT.includes("—"));
});

test("pctColor buckets by similarity threshold", () => {
  assert.equal(pctColor(0.95).ink, "#047857");
  assert.equal(pctColor(0.7).ink, "#a16207");
  assert.equal(pctColor(0.4).ink, "#3f3f46");
  assert.equal(pctColor(0.1).ink, "#71717a");
});

test("fmtBytes formats human-readable sizes", () => {
  assert.equal(fmtBytes(500), "500 B");
  assert.equal(fmtBytes(2048), "2.0 KB");
  assert.equal(fmtBytes(5 * 1024 * 1024), "5.00 MB");
});

test("fmtPct renders 1 decimal place", () => {
  assert.equal(fmtPct(0.8567), "85.7%");
  assert.equal(fmtPct(0), "0.0%");
  assert.equal(fmtPct(1), "100.0%");
});
