// Eval page model filter.
// The /api/runs CSV endpoint already accepts a model filter, but the /eval
// dashboard never exposed it, so reviewers narrowing to a specific base
// model had to hand-craft a URL. This pins the dropdown wiring on the
// client filter bar and the matching SSR plumbing on the page so the
// filter stays in sync with status and backend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("eval filter bar exposes a model dropdown alongside status and backend", async () => {
  const src = await read("components/EvalFilterBar.tsx");
  assert.match(src, /defaultModel\?: string/, "must accept the current model filter as a prop");
  assert.match(src, /models: string\[\]/, "must accept the list of selectable models as a prop");
  assert.match(src, /name="model"/, "must submit the model filter under the model name");
  assert.match(src, /defaultValue=\{defaultModel \?\? ""\}/, "must seed the dropdown with the active model filter");
  assert.match(src, /\{models\.map\(\(m\) => \(\s*<option key=\{m\} value=\{m\}>\s*\{m\}/, "must render one option per available model");
});

test("eval page reads the model filter and forwards it to the runs list and CSV", async () => {
  const src = await read("app/eval/page.tsx");
  assert.match(src, /sp\.model\?\.trim\(\)/, "must read model from the search params");
  assert.match(src, /if \(model && r\.model !== model\) return false;/, "must filter the in-memory run list by model");
  assert.match(src, /model\s*\?\s*`&model=\$\{encodeURIComponent\(model\)\}`/, "must forward model to the CSV export so the spreadsheet matches the screen");
  assert.match(src, /defaultModel=\{model\}/, "must hand the active model filter to the client filter bar");
  assert.match(src, /models=\{models\}/, "must hand the model option list to the client filter bar");
  assert.match(src, /filtering = !!\(q \|\| status \|\| backend \|\| model\)/, "must count model as an active filter when building the header count");
});
