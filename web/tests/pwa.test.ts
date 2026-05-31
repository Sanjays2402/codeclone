// PWA wiring test: manifest validity, icons present, service worker shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

test("manifest.webmanifest is valid and has the fields installers require", async () => {
  const raw = await readFile(path.join(ROOT, "public/manifest.webmanifest"), "utf8");
  const m = JSON.parse(raw);
  assert.equal(m.name, "codeclone");
  assert.equal(m.start_url, "/");
  assert.equal(m.display, "standalone");
  assert.equal(m.scope, "/");
  assert.ok(typeof m.theme_color === "string" && m.theme_color.startsWith("#"));
  assert.ok(typeof m.background_color === "string" && m.background_color.startsWith("#"));
  assert.ok(Array.isArray(m.icons) && m.icons.length >= 2);
  const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
  assert.ok(sizes.includes("192x192"), "needs a 192x192 icon");
  assert.ok(sizes.includes("512x512"), "needs a 512x512 icon");
});

test("declared icon files exist on disk", async () => {
  const raw = await readFile(path.join(ROOT, "public/manifest.webmanifest"), "utf8");
  const m = JSON.parse(raw) as { icons: { src: string }[] };
  for (const icon of m.icons) {
    const p = path.join(ROOT, "public", icon.src.replace(/^\//, ""));
    const s = await stat(p);
    assert.ok(s.isFile() && s.size > 0, `${icon.src} should be a non-empty file`);
  }
});

test("service worker exposes install/activate/fetch handlers and skips /api", async () => {
  const sw = await readFile(path.join(ROOT, "public/sw.js"), "utf8");
  assert.match(sw, /addEventListener\(["']install["']/);
  assert.match(sw, /addEventListener\(["']activate["']/);
  assert.match(sw, /addEventListener\(["']fetch["']/);
  assert.match(sw, /\/api\//, "must explicitly handle /api/ paths");
  assert.match(sw, /\/offline/, "must reference the offline fallback page");
});

test("layout wires manifest, theme-color, and the PWA client component", async () => {
  const layout = await readFile(path.join(ROOT, "app/layout.tsx"), "utf8");
  assert.match(layout, /manifest:\s*["']\/manifest\.webmanifest["']/);
  assert.match(layout, /themeColor/);
  assert.match(layout, /<PWAInstall\s*\/>/);
});
