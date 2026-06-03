/**
 * Run with: node --test --experimental-strip-types web/tests/pairs-min-sim.test.ts
 *
 * Pins the minimum-similarity filter on /pairs. A researcher
 * scanning a corpus of tens of thousands of clone pairs usually
 * only cares about near-duplicates (sim >= 0.8); the minSim
 * box lets them narrow the on-screen index, the CSV download,
 * and the underlying /api/pairs JSON to that slice in one place.
 *
 * Source-level pins for the page, route, and filter bar; plus a
 * live invocation of loadPairsList against the seeded fixtures to
 * confirm the threshold is honored end to end at the data layer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/pairs/page.tsx"),
  "utf8",
);
const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/pairs/route.ts"),
  "utf8",
);
const barSrc = fs.readFileSync(
  path.join(webRoot, "components/PairsFilterBar.tsx"),
  "utf8",
);

test("/pairs page parses minSim from the query string and passes it to loadPairsList", () => {
  assert.match(pageSrc, /const minSimRaw = sp\.minSim;/);
  assert.match(pageSrc, /Number\.isFinite\(n\) && n >= 0 && n <= 1/);
  assert.match(
    pageSrc,
    /loadPairsList\(\{[^}]*minSim[^}]*\}\)/,
    "must thread minSim into the data loader",
  );
});

test("/pairs page forwards minSim into the Download CSV link", () => {
  assert.match(
    pageSrc,
    /csvParams\.set\("minSim",\s*String\(minSim\)\)/,
    "must propagate the active minSim into the CSV download so the spreadsheet matches the screen",
  );
});

test("/pairs filter bar exposes a minSim input", () => {
  assert.match(barSrc, /name="minSim"/);
  assert.match(barSrc, /type="number"/);
  assert.match(barSrc, /min=\{0\}/);
  assert.match(barSrc, /max=\{1\}/);
  assert.match(barSrc, /step=\{0\.05\}/);
  assert.match(barSrc, /aria-label="Minimum similarity \(0 to 1\)"/);
  assert.match(barSrc, /defaultMinSim\?:\s*number/);
});

test("/api/pairs validates minSim and rejects out-of-range values with 400", () => {
  assert.match(routeSrc, /url\.searchParams\.get\("minSim"\)/);
  assert.match(
    routeSrc,
    /minSim must be a number between 0 and 1/,
    "must reject malformed minSim with an invalid_request 400",
  );
  // The threshold has to reach both the CSV branch and the JSON fallthrough,
  // otherwise users could only filter the spreadsheet or only the API.
  const csvBranch = routeSrc.split('if (format === "csv")')[1] ?? "";
  assert.match(csvBranch, /minSim/, "csv branch must honor minSim");
  assert.match(
    routeSrc,
    /loadPairsList\(\{\s*limit,\s*offset,\s*q,\s*lang,\s*minSim\s*\}\)/,
    "json branch must honor minSim",
  );
});

test("loadPairsList honors a minSim threshold in its filter chain", async () => {
  // Source-level pin to match the rest of the pairs suite, which avoids
  // depending on whether the test runner happened to seed the fixtures.
  const dataSrc = fs.readFileSync(path.join(webRoot, "lib/data.ts"), "utf8");
  assert.match(
    dataSrc,
    /loadPairsList\(opts:\s*\{[^}]*minSim\?:\s*number[^}]*\}/,
    "loader signature must accept minSim",
  );
  assert.match(
    dataSrc,
    /filtered = filtered\.filter\(p => p\.similarity >= min\)/,
    "loader must filter pairs by p.similarity >= minSim",
  );
  assert.match(
    dataSrc,
    /opts\.minSim !== undefined && Number\.isFinite\(opts\.minSim\) && opts\.minSim > 0/,
    "loader must guard against undefined, NaN, and the 0 no-op so an empty filter box returns the full corpus",
  );
});
