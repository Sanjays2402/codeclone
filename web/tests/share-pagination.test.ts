/**
 * Run with: node --test --experimental-strip-types web/tests/share-pagination.test.ts
 *
 * Covers the server-side pagination + filter additions to the share store:
 * listSharesPage offset/limit, language facet, clone-label filter, and
 * minScore/maxScore bounds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-shares-page-"));
process.env.CODECLONE_SHARES_DIR = tmp;

const { createShare, listSharesPage } = await import("../lib/share.ts");

function fakeResult(score: number, label: string, lang: string) {
  return {
    language: lang,
    scores: { shingleJaccard: score, tokenJaccard: score, containment: score },
    alignment: { rows: [] },
    clone: {
      label,
      confidence: 0.7,
      structuralSim: score,
      rawTokenSim: score,
      rationale: [],
    },
    bytes: { a: 10, b: 10 },
    latency_ms: 1,
    method: "test",
  } as any;
}

async function seed() {
  const rows = [
    { score: 0.95, label: "Type-1", lang: "javascript", title: "alpha" },
    { score: 0.8, label: "Type-2", lang: "python", title: "beta" },
    { score: 0.6, label: "Type-3", lang: "python", title: "gamma" },
    { score: 0.4, label: "Type-3", lang: "go", title: "delta" },
    { score: 0.2, label: "None", lang: "javascript", title: "epsilon" },
    { score: 0.05, label: "None", lang: "rust", title: "zeta" },
  ];
  const ids: string[] = [];
  for (const r of rows) {
    const rec = await createShare({
      a: "a",
      b: "b",
      language: r.lang,
      title: r.title,
      result: fakeResult(r.score, r.label, r.lang),
    });
    ids.push(rec.id);
    // Stagger createdAt so sort order is deterministic.
    await new Promise((r) => setTimeout(r, 5));
  }
  return ids;
}

test("listSharesPage: paginates with offset/limit and reports total", async () => {
  await seed();
  const p1 = await listSharesPage({ limit: 2, offset: 0 });
  assert.equal(p1.total, 6);
  assert.equal(p1.items.length, 2);
  assert.equal(p1.offset, 0);
  assert.equal(p1.limit, 2);

  const p2 = await listSharesPage({ limit: 2, offset: 2 });
  assert.equal(p2.items.length, 2);
  assert.equal(p2.offset, 2);

  const p3 = await listSharesPage({ limit: 2, offset: 4 });
  assert.equal(p3.items.length, 2);

  const p4 = await listSharesPage({ limit: 2, offset: 6 });
  assert.equal(p4.items.length, 0);

  // No duplicate ids across pages.
  const seen = new Set<string>();
  for (const it of [...p1.items, ...p2.items, ...p3.items]) {
    assert.ok(!seen.has(it.id), `duplicate id across pages: ${it.id}`);
    seen.add(it.id);
  }
});

test("listSharesPage: facets count every record, not just the page", async () => {
  const page = await listSharesPage({ limit: 2, offset: 0 });
  const langs = Object.fromEntries(page.facets.languages.map((f) => [f.name, f.count]));
  assert.equal(langs.javascript, 2);
  assert.equal(langs.python, 2);
  assert.equal(langs.go, 1);
  assert.equal(langs.rust, 1);
  const labels = Object.fromEntries(page.facets.cloneLabels.map((f) => [f.name, f.count]));
  assert.equal(labels["Type-3"], 2);
  assert.equal(labels["None"], 2);
});

test("listSharesPage: language + cloneLabel filters narrow the result", async () => {
  const pyOnly = await listSharesPage({ language: "python", limit: 50 });
  assert.equal(pyOnly.total, 2);
  for (const it of pyOnly.items) assert.equal(it.language, "python");

  const noneOnly = await listSharesPage({ cloneLabel: "None", limit: 50 });
  assert.equal(noneOnly.total, 2);
  for (const it of noneOnly.items) assert.equal(it.cloneLabel, "None");

  const both = await listSharesPage({
    language: "python",
    cloneLabel: "Type-3",
    limit: 50,
  });
  assert.equal(both.total, 1);
  assert.equal(both.items[0].language, "python");
  assert.equal(both.items[0].cloneLabel, "Type-3");

  const all = await listSharesPage({ language: "all", cloneLabel: "all", limit: 50 });
  assert.equal(all.total, 6);
});

test("listSharesPage: minScore and maxScore bound similarity", async () => {
  const high = await listSharesPage({ minScore: 0.75, limit: 50 });
  assert.equal(high.total, 2);
  for (const it of high.items) assert.ok(it.shingleJaccard >= 0.75);

  const mid = await listSharesPage({ minScore: 0.3, maxScore: 0.7, limit: 50 });
  assert.equal(mid.total, 2);
  for (const it of mid.items) {
    assert.ok(it.shingleJaccard >= 0.3 && it.shingleJaccard <= 0.7);
  }

  // Out-of-range clamp-friendly inputs should still behave sanely.
  const allByScore = await listSharesPage({ minScore: 0, maxScore: 1, limit: 50 });
  assert.equal(allByScore.total, 6);
});

test("listSharesPage: q search still works alongside new filters", async () => {
  const r = await listSharesPage({ q: "python", limit: 50 });
  assert.ok(r.total >= 2);
  for (const it of r.items) {
    const hay = `${it.title ?? ""} ${it.language} ${it.cloneLabel} ${it.id}`.toLowerCase();
    assert.ok(hay.includes("python"));
  }
});
