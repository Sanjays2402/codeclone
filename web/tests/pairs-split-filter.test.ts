/**
 * Run with: node --test --experimental-strip-types web/tests/pairs-split-filter.test.ts
 *
 * Pins the dataset-split filter on /pairs. The on-screen table already
 * shows a per-row `split` column (train/val/test) but until now there was
 * no way to slice the index by it, so a researcher who wanted to inspect
 * just the held-out test split had to scroll a 300-row table and eyeball
 * a column. The split dropdown lets them narrow the page, the CSV
 * download, and the underlying /api/pairs JSON to that one split in one
 * place, matching the existing lang and minSim filters.
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
const dataSrc = fs.readFileSync(
  path.join(webRoot, "lib/data.ts"),
  "utf8",
);

test("/pairs page parses split from the query string and passes it to loadPairsList", () => {
  assert.match(pageSrc, /const splitRaw = sp\.split\?\.trim\(\);/);
  assert.match(
    pageSrc,
    /splitRaw === "train" \|\| splitRaw === "val" \|\| splitRaw === "test"/,
    "must whitelist split values so a junk ?split=foo is ignored, not coerced",
  );
  assert.match(
    pageSrc,
    /loadPairsList\(\{[^}]*split[^}]*\}\)/,
    "must thread split into the data loader",
  );
});

test("/pairs page forwards split into the Download CSV link", () => {
  assert.match(
    pageSrc,
    /csvParams\.set\("split",\s*split\)/,
    "must propagate the active split into the CSV download so the spreadsheet matches the screen",
  );
});

test("/pairs filter bar exposes a split <select>", () => {
  assert.match(barSrc, /name="split"/);
  assert.match(barSrc, /defaultSplit\?:\s*"train"\s*\|\s*"val"\s*\|\s*"test"/);
  assert.match(barSrc, /<option value="train">train<\/option>/);
  assert.match(barSrc, /<option value="val">val<\/option>/);
  assert.match(barSrc, /<option value="test">test<\/option>/);
  assert.match(barSrc, /aria-label="Dataset split"/);
});

test("/api/pairs validates split and rejects unknown values with 400", () => {
  assert.match(routeSrc, /url\.searchParams\.get\("split"\)/);
  assert.match(
    routeSrc,
    /split must be one of 'train', 'val', or 'test'/,
    "must reject unknown split with an invalid_request 400 instead of silently returning the unfiltered corpus",
  );
  const csvBranch = routeSrc.split('if (format === "csv")')[1] ?? "";
  assert.match(csvBranch, /split/, "csv branch must honor split");
  assert.match(
    routeSrc,
    /loadPairsList\(\{\s*limit,\s*offset,\s*q,\s*lang,\s*minSim,\s*split\s*\}\)/,
    "json branch must honor split",
  );
});

test("loadPairsList honors a split selector in its filter chain", () => {
  assert.match(
    dataSrc,
    /loadPairsList\(opts:\s*\{[^}]*split\?:\s*PairSummary\["split"\][^}]*\}/,
    "loader signature must accept split",
  );
  assert.match(
    dataSrc,
    /if \(opts\.split\) filtered = filtered\.filter\(p => p\.split === opts\.split\)/,
    "loader must filter pairs by p.split === opts.split",
  );
});
