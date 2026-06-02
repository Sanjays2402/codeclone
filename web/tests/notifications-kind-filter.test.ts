import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "codeclone-notif-kind-"));
process.env.CODECLONE_NOTIFICATIONS_DIR = dir;

const {
  createNotification,
  isNotificationKind,
  listNotifications,
} = await import("../lib/notifications.ts");

const USER = "u-kind-filter";

await createNotification({ userId: USER, kind: "share.created", title: "s1" });
await createNotification({ userId: USER, kind: "batch.completed", title: "b1" });
await createNotification({ userId: USER, kind: "webhook.failed", title: "w1" });
await createNotification({ userId: USER, kind: "system", title: "y1" });
await createNotification({ userId: USER, kind: "webhook.failed", title: "w2" });

test("listNotifications without kinds returns everything", async () => {
  const all = await listNotifications(USER, {});
  assert.equal(all.length, 5);
});

test("listNotifications filters by a single kind", async () => {
  const only = await listNotifications(USER, { kinds: ["webhook.failed"] });
  assert.equal(only.length, 2);
  for (const r of only) assert.equal(r.kind, "webhook.failed");
});

test("listNotifications filters by multiple kinds", async () => {
  const some = await listNotifications(USER, {
    kinds: ["share.created", "system"],
  });
  assert.equal(some.length, 2);
  const kinds = some.map((r) => r.kind).sort();
  assert.deepEqual(kinds, ["share.created", "system"]);
});

test("listNotifications kinds + unreadOnly compose", async () => {
  // All records are unread by default, so unreadOnly should not change the count.
  const some = await listNotifications(USER, {
    kinds: ["batch.completed"],
    unreadOnly: true,
  });
  assert.equal(some.length, 1);
  assert.equal(some[0]!.kind, "batch.completed");
});

test("empty kinds array behaves like no filter", async () => {
  const all = await listNotifications(USER, { kinds: [] });
  assert.equal(all.length, 5);
});

test("isNotificationKind accepts known kinds and rejects others", () => {
  assert.equal(isNotificationKind("share.created"), true);
  assert.equal(isNotificationKind("batch.completed"), true);
  assert.equal(isNotificationKind("webhook.failed"), true);
  assert.equal(isNotificationKind("system"), true);
  assert.equal(isNotificationKind("nope"), false);
  assert.equal(isNotificationKind(""), false);
  assert.equal(isNotificationKind(42), false);
  assert.equal(isNotificationKind(null), false);
});

process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});
