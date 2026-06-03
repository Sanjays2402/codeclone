/**
 * Run with: node --test --experimental-strip-types web/tests/batch-csv.test.ts
 *
 * Pins the client-side "Download CSV" button on /batch. A researcher
 * who runs the matrix should be able to export the similarity grid
 * plus the per-pair clone-type breakdown as a spreadsheet in one
 * click, without screen-scraping the heatmap.
 *
 * Source-level (no jsdom) so it runs with the same node --test rig
 * the rest of the suite uses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");
const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/batch/page.tsx"),
  "utf8",
);

test("batch page exposes a Download CSV button on the matrix", () => {
  assert.match(pageSrc, /onClick=\{downloadMatrixCsv\}/, "must wire the button to the downloadMatrixCsv handler");
  assert.match(pageSrc, /Download CSV/, "must label the button so users find it");
  assert.match(pageSrc, /DownloadSimple/, "must use the DownloadSimple icon");
});

test("downloadMatrixCsv builds a CSV with the matrix and per-pair scores", () => {
  assert.match(pageSrc, /const downloadMatrixCsv = useCallback\(/, "must define a stable downloadMatrixCsv callback");
  assert.match(pageSrc, /if \(!result\) return;/, "must early-return when no matrix has been run");
  // Header row of the matrix uses the snippet labels so reviewers can
  // tell which row/column is which when they open the file in Sheets.
  assert.match(pageSrc, /\["label", \.\.\.labels\]/, "must put labels in the matrix header row");
  // Pair-level section: every cell the heatmap shows must also be in
  // the spreadsheet, with shingle/token/containment plus clone verdict.
  assert.match(pageSrc, /shingle_jaccard/, "must export shingle_jaccard per pair");
  assert.match(pageSrc, /token_jaccard/, "must export token_jaccard per pair");
  assert.match(pageSrc, /containment/, "must export containment per pair");
  assert.match(pageSrc, /clone_type/, "must export the clone type verdict per pair");
  assert.match(pageSrc, /clone_confidence/, "must export the clone confidence per pair");
  // Standard browser download wiring.
  assert.match(pageSrc, /type: "text\/csv;charset=utf-8"/, "must set the CSV MIME type so browsers handle it correctly");
  assert.match(pageSrc, /URL\.createObjectURL\(blob\)/, "must create an object URL for the download anchor");
  assert.match(pageSrc, /URL\.revokeObjectURL\(url\)/, "must release the object URL after the click");
  assert.match(pageSrc, /link\.download = `codeclone-batch-\$\{stamp\}\$\{suffix\}\.csv`/, "must use a timestamped, namespaced filename (with optional min-score suffix)");
});

test("CSV escaper handles quotes, commas, and newlines in snippet labels", () => {
  // The /batch UI lets users type any label they want, including
  // commas and quotes. The escaper must wrap those in quotes and
  // double-up embedded quotes so the file parses in Sheets/Excel.
  assert.match(pageSrc, /\/\[",\\n\\r\]\//, "must detect characters that require CSV quoting");
  assert.match(pageSrc, /replace\(\/"\/g, '""'\)/, "must double-up embedded double quotes");
});
