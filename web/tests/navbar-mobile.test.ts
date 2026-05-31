// NavBar mobile wiring test: hamburger toggle, lg breakpoint hide/show, drawer markup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("NavBar ships a mobile hamburger button hidden on lg+", async () => {
  const src = await read("components/NavBar.tsx");
  assert.match(src, /aria-label="Open menu"/, "hamburger needs accessible label");
  assert.match(src, /aria-controls="mobile-nav-drawer"/);
  assert.match(src, /lg:hidden/, "hamburger should be hidden on lg+");
  assert.match(src, /weight="duotone"/, "Phosphor icons should use duotone weight");
});

test("NavBar desktop nav is hidden below lg breakpoint", async () => {
  const src = await read("components/NavBar.tsx");
  // The desktop <nav> uses hidden lg:flex so it disappears on mobile.
  assert.match(src, /className="hidden lg:flex items-center gap-1/);
});

test("NavBar renders a closable drawer with all nav items", async () => {
  const src = await read("components/NavBar.tsx");
  assert.match(src, /id="mobile-nav-drawer"/);
  assert.match(src, /role="dialog"/);
  assert.match(src, /aria-modal="true"/);
  assert.match(src, /aria-label="Close menu"/);
  // Drawer iterates over the same items array, so picking a few representative ones
  // ensures the full menu is wired without coupling the test to ordering.
  for (const label of ["overview", "history", "api keys", "webhooks", "settings"]) {
    assert.ok(src.includes(`label: "${label}"`), `nav must include ${label}`);
  }
});

test("layout main uses responsive horizontal padding", async () => {
  const src = await read("app/layout.tsx");
  assert.match(src, /px-4 sm:px-7/);
});
