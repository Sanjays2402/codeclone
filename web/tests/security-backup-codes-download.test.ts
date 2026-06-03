// Settings -> Security "download .txt" button wiring for MFA backup codes.
// Backup codes are shown exactly once after enroll or regenerate, and the
// usual user reflex is to save them to a file (password-manager attachment,
// printed copy in a safe). "Copy all" already shipped; this pins the
// matching download path so users don't have to paste into a text editor.
// Source-level so it runs with the same node --test rig the rest of the
// suite uses, no jsdom required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

async function read(p: string): Promise<string> {
  return readFile(path.join(ROOT, p), "utf8");
}

test("security page exposes a download-.txt button alongside copy-all", async () => {
  const src = await read("app/settings/security/page.tsx");
  assert.match(src, /onClick=\{\(\) => downloadCodes\(backupCodes\)\}/, "must wire the button to the downloadCodes handler");
  assert.match(src, /Download \.txt/, "must label the button so users find it");
  assert.match(src, /DownloadSimple/, "must use the DownloadSimple icon");
  // Copy-all must still be present so we don't regress the existing path.
  assert.match(src, /onClick=\{\(\) => copyAll\(backupCodes\)\}/, "must keep the copy-all button next to download");
});

test("downloadCodes builds a plain-text blob with a header and timestamped filename", async () => {
  const src = await read("app/settings/security/page.tsx");
  assert.match(src, /const downloadCodes = useCallback\(/, "must define a stable downloadCodes callback");
  assert.match(src, /codeclone MFA backup codes/, "must stamp a header so users recognise the file later");
  assert.match(src, /type: "text\/plain;charset=utf-8"/, "must set the text MIME type so browsers handle it correctly");
  assert.match(src, /URL\.createObjectURL\(blob\)/, "must create an object URL for the download anchor");
  assert.match(src, /URL\.revokeObjectURL\(url\)/, "must release the object URL after the click");
  assert.match(src, /link\.download = `codeclone-backup-codes-\$\{stamp\}\.txt`/, "must use a timestamped, namespaced filename");
});

test("downloadCodes is a no-op when there are no codes to save", async () => {
  const src = await read("app/settings/security/page.tsx");
  // The handler must early-return on an empty list so the UI can't write a
  // misleading "0 codes" file if state ever races against a regenerate.
  assert.match(src, /if \(!codes \|\| codes\.length === 0\) return;/, "must early-return when no codes are loaded");
});
