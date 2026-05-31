/**
 * Run with: node --test --experimental-strip-types web/tests/settings.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-settings-"));
process.env.CODECLONE_SETTINGS_FILE = path.join(tmp, "settings.json");
process.env.CODECLONE_SHARES_DIR = path.join(tmp, "shares");
process.env.CODECLONE_KEYS_DIR = path.join(tmp, "keys");
process.env.CODECLONE_WEBHOOKS_DIR = path.join(tmp, "webhooks");
fs.mkdirSync(process.env.CODECLONE_SHARES_DIR, { recursive: true });
fs.mkdirSync(process.env.CODECLONE_KEYS_DIR, { recursive: true });
fs.mkdirSync(process.env.CODECLONE_WEBHOOKS_DIR, { recursive: true });

const {
  loadPreferences,
  updatePreferences,
  exportAll,
  wipeAll,
  DEFAULTS,
} = await import("../lib/settings.ts");
const { createKey } = await import("../lib/api-keys.ts");

test("settings: defaults when no file exists", async () => {
  const p = await loadPreferences();
  assert.equal(p.defaultLanguage, DEFAULTS.defaultLanguage);
  assert.equal(p.cloneThreshold, DEFAULTS.cloneThreshold);
  assert.equal(p.notifyOnWebhookFailure, true);
});

test("settings: update persists and clamps inputs", async () => {
  const next = await updatePreferences({
    defaultLanguage: "python",
    cloneThreshold: 2.5, // clamped to 1
    retentionDays: -10,  // clamped to 0
    notifyOnCompareCompleted: true,
    notifyOnWebhookFailure: false,
  });
  assert.equal(next.defaultLanguage, "python");
  assert.equal(next.cloneThreshold, 1);
  assert.equal(next.retentionDays, 0);
  assert.equal(next.notifyOnCompareCompleted, true);
  assert.equal(next.notifyOnWebhookFailure, false);
  const reload = await loadPreferences();
  assert.equal(reload.defaultLanguage, "python");
});

test("settings: invalid language falls back to default", async () => {
  const next = await updatePreferences({ defaultLanguage: "klingon" });
  assert.equal(next.defaultLanguage, DEFAULTS.defaultLanguage);
});

test("settings: exportAll bundles prefs and key metadata without hashes", async () => {
  await createKey("test key");
  const bundle = await exportAll();
  assert.equal(bundle.v, 1);
  assert.ok(bundle.exportedAt > 0);
  assert.equal(bundle.counts.apiKeys, 1);
  // listKeys returns summaries (no hash field); guard against leaks.
  for (const k of bundle.apiKeys as Array<Record<string, unknown>>) {
    assert.equal(k.hash, undefined);
  }
});

test("settings: wipeAll removes keys and prefs", async () => {
  await createKey("doomed");
  const result = await wipeAll();
  assert.ok(result.apiKeys >= 1);
  assert.equal(result.preferencesReset, true);
  // After wipe, prefs load returns defaults again.
  const p = await loadPreferences();
  assert.equal(p.updatedAt, 0);
});
