/**
 * Run with: node --test --experimental-strip-types web/tests/collection-detail-json-download.test.ts
 *
 * Pins the JSON download button on /collections/[id]. Users who narrowed
 * a collection on the dashboard can already grab the items table as CSV
 * (collections-csv.test.ts pins that), but the CSV strips the collection
 * title, description, and updatedAt fields. A JSON button next to the
 * CSV gives them the full record back so they can back it up, diff two
 * collections, or hand it to a re-import script without scraping the page.
 *
 * The /api/collections/[id] GET already defaults to JSON, so this only
 * pins the page-level wiring: a JSON link is rendered, it points at
 * format=json, and it has a download filename so browsers do not open
 * the response inline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const pageSrc = fs.readFileSync(
  path.join(webRoot, "app/collections/[id]/page.tsx"),
  "utf8",
);
const routeSrc = fs.readFileSync(
  path.join(webRoot, "app/api/collections/[id]/route.ts"),
  "utf8",
);

test("/collections/[id] page renders a JSON download link", () => {
  assert.match(
    pageSrc,
    /\/api\/collections\/\$\{id\}\?format=json/,
    "page must link to /api/collections/[id]?format=json",
  );
  assert.match(
    pageSrc,
    /download=\{`codeclone-collection-\$\{id\}\.json`\}/,
    "page must set a download filename so browsers save instead of opening inline",
  );
});

test("JSON download is always shown, even on empty collections", () => {
  // The CSV button is gated on data.items.length > 0 because an empty
  // items table is useless. JSON includes the collection metadata
  // (title, description, shareIds) and is still worth exporting on an
  // empty collection, so its anchor must not sit inside the same
  // items-length conditional.
  const jsonIdx = pageSrc.indexOf("codeclone-collection-${id}.json");
  assert.ok(jsonIdx > 0, "JSON download anchor must exist");
  // Find the nearest preceding `{data.items.length > 0 && (` opener,
  // then its matching `)}` close, and assert the JSON anchor sits
  // outside that range.
  const opener = "{data.items.length > 0 && (";
  const closer = ")}";
  const openIdx = pageSrc.lastIndexOf(opener, jsonIdx);
  if (openIdx >= 0) {
    const closeIdx = pageSrc.indexOf(closer, openIdx);
    assert.ok(
      closeIdx < 0 || jsonIdx < openIdx || jsonIdx > closeIdx,
      "JSON download must not be hidden behind the items-length conditional",
    );
  }
});

test("/api/collections/[id] route still serves JSON by default", () => {
  // The new button relies on format=json being accepted (the route
  // already defaults to json, but we pin the explicit value too so a
  // future refactor that tightens the allow-list does not silently
  // 400 the dashboard button).
  assert.match(
    routeSrc,
    /format !== "json" && format !== "csv"/,
    "route must accept format=json (default) and format=csv",
  );
});
