#!/usr/bin/env node
/**
 * Smoke test for the /api/share + /r/[id] flow.
 *
 * Boots `next dev` against a temp shares dir, POSTs a share, GETs it,
 * and fetches /r/<id> as a public HTML page.
 *
 * Run from web/: node scripts/test-share.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = process.env.PORT || "3457";
const BASE = `http://127.0.0.1:${PORT}`;
const sharesDir = mkdtempSync(path.join(tmpdir(), "codeclone-shares-"));

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(url, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return;
    } catch {}
    await wait(400);
  }
  throw new Error(`server never came up at ${url}`);
}

const env = { ...process.env, PORT, CODECLONE_SHARES_DIR: sharesDir };
const child = spawn("npx", ["next", "dev", "-p", PORT], { env, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", d => { out += d.toString(); });
child.stderr.on("data", d => { out += d.toString(); });

let exitCode = 1;
try {
  await waitFor(`${BASE}/api/health`);

  const a = "function add(a, b) {\n  return a + b;\n}\n";
  const b = "function sum(x, y) {\n  return x + y;\n}\n";
  const post = await fetch(`${BASE}/api/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ a, b, language: "javascript" }),
  });
  if (post.status !== 201) throw new Error(`POST /api/share -> ${post.status}: ${await post.text()}`);
  const created = await post.json();
  if (!created.id || !/^[A-Za-z0-9_-]+$/.test(created.id)) throw new Error(`bad id: ${JSON.stringify(created)}`);

  const get = await fetch(`${BASE}/api/share/${created.id}`);
  if (!get.ok) throw new Error(`GET /api/share/<id> -> ${get.status}`);
  const rec = await get.json();
  if (rec.a !== a || rec.b !== b) throw new Error("round-trip mismatch on snippets");
  if (typeof rec.result?.scores?.shingleJaccard !== "number") throw new Error("missing scores in record");

  const page = await fetch(`${BASE}/r/${created.id}`);
  if (!page.ok) throw new Error(`GET /r/<id> -> ${page.status}`);
  const html = await page.text();
  if (!html.includes("shared result")) throw new Error("public page did not render");

  const missing = await fetch(`${BASE}/api/share/doesnotexist`);
  if (missing.status !== 404) throw new Error(`expected 404 on missing share, got ${missing.status}`);

  const bad = await fetch(`${BASE}/api/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ a: "", b: "x" }),
  });
  if (bad.status !== 400) throw new Error(`expected 400 on empty input, got ${bad.status}`);

  console.log(`ok · created ${created.id}, round-tripped, rendered, validated`);
  exitCode = 0;
} catch (e) {
  console.error("FAIL:", e.message);
  console.error("--- next dev output (tail) ---");
  console.error(out.slice(-2000));
} finally {
  child.kill("SIGTERM");
  await wait(300);
  try { child.kill("SIGKILL"); } catch {}
  try { rmSync(sharesDir, { recursive: true, force: true }); } catch {}
  process.exit(exitCode);
}
