/**
 * Run with: node --test --experimental-strip-types web/tests/models-min-pass.test.ts
 *
 * Pins the minimum pass@1 filter on /models. A researcher
 * picking an adapter to ship usually only cares about ones
 * that cleared a quality bar (e.g. pass@1 >= 0.5); the minPass
 * box lets them narrow the on-screen registry, the CSV download,
 * and the underlying /api/models JSON to that slice in one place.
 *
 * Source-level pins for the page, route, and filter bar.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/models/page.tsx"),
  "utf8",
);
const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/models/route.ts"),
  "utf8",
);
const barSrc = fs.readFileSync(
  path.join(webRoot, "components/ModelsFilterBar.tsx"),
  "utf8",
);

test("/models page parses minPass from the query string and filters in-memory", () => {
  assert.match(pageSrc, /const minPassRaw = sp\.minPass;/);
  assert.match(pageSrc, /Number\.isFinite\(n\) && n >= 0 && n <= 1/);
  assert.match(
    pageSrc,
    /score < minPass/,
    "must drop adapters whose pass@1 (or mini_pass_rate fallback) is below the threshold",
  );
});

test("/models page forwards minPass into the Download CSV link", () => {
  assert.match(
    pageSrc,
    /csvParams\.set\("minPass",\s*String\(minPass\)\)/,
    "must propagate the active minPass into the CSV download so the spreadsheet matches the screen",
  );
});

test("/models filter bar exposes a minPass input", () => {
  assert.match(barSrc, /name="minPass"/);
  assert.match(barSrc, /type="number"/);
  assert.match(barSrc, /min=\{0\}/);
  assert.match(barSrc, /max=\{1\}/);
  assert.match(barSrc, /step=\{0\.05\}/);
  assert.match(barSrc, /aria-label="Minimum pass@1 \(0 to 1\)"/);
  assert.match(barSrc, /defaultMinPass\?:\s*number/);
});

test("/api/models validates minPass and rejects out-of-range values with 400", () => {
  assert.match(routeSrc, /url\.searchParams\.get\("minPass"\)/);
  assert.match(
    routeSrc,
    /minPass must be a number between 0 and 1/,
    "must reject malformed minPass with an invalid_request 400",
  );
  // The threshold has to apply before the format branch so both CSV and
  // JSON callers see the same narrowed slice, not just the spreadsheet.
  const csvBranchIdx = routeSrc.indexOf('if (format === "csv")');
  assert.ok(csvBranchIdx > 0, "csv branch must exist");
  const beforeCsv = routeSrc.slice(0, csvBranchIdx);
  assert.match(
    beforeCsv,
    /adapters = adapters\.filter\(\(a\) => \{[\s\S]*ev\.pass_at_1 \?\? ev\.mini_pass_rate/,
    "minPass filter must run before the format branch so JSON callers also see the narrowed slice",
  );
});

test("/api/models reuses a single eval-report load for the filter and the CSV join", () => {
  // Guard against accidentally double-reading the registry on every request,
  // which was easy to slip in when adding the new threshold filter.
  const matches = routeSrc.match(/loadEvalReports\(\)/g) ?? [];
  assert.equal(
    matches.length,
    1,
    "loadEvalReports() must be called exactly once per request",
  );
});
