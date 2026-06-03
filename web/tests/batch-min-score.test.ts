/**
 * Run with: node --test --experimental-strip-types web/tests/batch-min-score.test.ts
 *
 * Pins the min-similarity threshold slider on /batch. A reviewer
 * running a 12-snippet matrix gets 66 pairs back; the slider lets
 * them dim cells below a threshold so the heatmap reads cleaner,
 * and the same threshold filters the CSV pair section so the
 * spreadsheet matches what is on screen. Diagonal stays disabled
 * and the matrix itself remains rectangular so downstream tools
 * that parse the file do not break.
 *
 * Source-level (no jsdom) to match the rest of the batch suite.
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

test("batch page wires a minScore threshold slider", () => {
  assert.match(pageSrc, /const \[minScore, setMinScore\] = useState<number>\(0\);/, "must hold the threshold in state, default 0");
  assert.match(pageSrc, /type="range"/, "must render a slider input");
  assert.match(pageSrc, /min=\{0\}/, "slider must start at 0");
  assert.match(pageSrc, /max=\{1\}/, "slider must top out at 1");
  assert.match(pageSrc, /step=\{0\.05\}/, "slider must step in 0.05 increments");
  assert.match(pageSrc, /onChange=\{e => setMinScore\(Number\(e\.target\.value\)\)\}/, "slider must update minScore");
  assert.match(pageSrc, /aria-label="Minimum shingle Jaccard threshold"/, "slider must be labeled for screen readers");
});

test("matrix cells below the threshold are dimmed and disabled", () => {
  assert.match(pageSrc, /const belowMin = !isDiag && v < minScore;/, "must compute a below-threshold flag per cell, sparing the diagonal");
  assert.match(pageSrc, /disabled=\{isDiag \|\| belowMin\}/, "below-threshold cells must be unclickable so users cannot inspect filtered pairs");
  assert.match(pageSrc, /belowMin \? "cursor-not-allowed opacity-25"/, "below-threshold cells must dim visually");
});

test("CSV pair section honors the threshold but the matrix stays rectangular", () => {
  assert.match(
    pageSrc,
    /const pairCells = result\.cells\.filter\(c => c\.scores\.shingleJaccard >= minScore\);/,
    "must filter pair rows by the on-screen threshold",
  );
  assert.match(pageSrc, /for \(const c of pairCells\)/, "the pair-section loop must use the filtered list");
  // The matrix section above the pair section must still iterate over
  // result.matrix without the filter so the grid stays square.
  assert.match(pageSrc, /for \(let i = 0; i < result\.matrix\.length; i\+\+\)/, "matrix section must keep iterating the full grid");
  // Filename suffix so users can tell a filtered export apart from a full one.
  assert.match(pageSrc, /const suffix = minScore > 0 \? `-min\$\{minScore\.toFixed\(2\)\}` : "";/, "filename must record the threshold when non-zero");
  assert.match(pageSrc, /codeclone-batch-\$\{stamp\}\$\{suffix\}\.csv/, "download filename must include the threshold suffix");
});

test("downloadMatrixCsv depends on minScore so the callback updates when the slider moves", () => {
  assert.match(pageSrc, /\}, \[result, minScore\]\);/, "useCallback deps must include minScore so a stale closure cannot ship the wrong file");
});
