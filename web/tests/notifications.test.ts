/**
 * Run with: node --test --experimental-strip-types web/tests/notifications.test.ts
 *
 * Black-box test for the per-user notifications inbox. Uses a temp dir so
 * it never touches real data.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-notifs-"));
process.env.CODECLONE_NOTIFICATIONS_DIR = tmp;

const {
  createNotification,
  emitNotification,
  listNotifications,
  countUnread,
  markRead,
  markAllRead,
  deleteNotification,
  clearAll,
  isNotificationId,
  MAX_PER_USER,
} = await import("../lib/notifications.ts");

const USER = "u_test";

test("create + list returns newest first", async () => {
  await clearAll(USER);
  const a = await createNotification({ userId: USER, kind: "system", title: "first" });
  await new Promise((r) => setTimeout(r, 5));
  const b = await createNotification({ userId: USER, kind: "share.created", title: "second" });
  const list = await listNotifications(USER);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b.id);
  assert.equal(list[1].id, a.id);
  assert.equal(await countUnread(USER), 2);
});

test("isolation between users", async () => {
  await clearAll(USER);
  await clearAll("u_other");
  await createNotification({ userId: USER, kind: "system", title: "mine" });
  const other = await listNotifications("u_other");
  assert.equal(other.length, 0);
  const mine = await listNotifications(USER);
  assert.equal(mine.length, 1);
});

test("markRead toggles and counter updates", async () => {
  await clearAll(USER);
  const rec = await createNotification({ userId: USER, kind: "system", title: "x" });
  assert.equal(await countUnread(USER), 1);
  const updated = await markRead(USER, rec.id, true);
  assert.ok(updated?.readAt);
  assert.equal(await countUnread(USER), 0);
  const back = await markRead(USER, rec.id, false);
  assert.equal(back?.readAt, undefined);
  assert.equal(await countUnread(USER), 1);
});

test("markAllRead returns the number it touched", async () => {
  await clearAll(USER);
  await createNotification({ userId: USER, kind: "system", title: "a" });
  await createNotification({ userId: USER, kind: "system", title: "b" });
  await createNotification({ userId: USER, kind: "system", title: "c" });
  const n = await markAllRead(USER);
  assert.equal(n, 3);
  assert.equal(await countUnread(USER), 0);
  // Second call is a no-op.
  assert.equal(await markAllRead(USER), 0);
});

test("delete removes a single record; returns false for unknown id", async () => {
  await clearAll(USER);
  const rec = await createNotification({ userId: USER, kind: "system", title: "x" });
  assert.equal(await deleteNotification(USER, rec.id), true);
  assert.equal((await listNotifications(USER)).length, 0);
  assert.equal(await deleteNotification(USER, "abcdef1234"), false);
});

test("unreadOnly filter works", async () => {
  await clearAll(USER);
  const a = await createNotification({ userId: USER, kind: "system", title: "a" });
  await createNotification({ userId: USER, kind: "system", title: "b" });
  await markRead(USER, a.id, true);
  const unread = await listNotifications(USER, { unreadOnly: true });
  assert.equal(unread.length, 1);
  assert.equal(unread[0].title, "b");
});

test("createNotification rejects invalid input", async () => {
  await assert.rejects(
    () => createNotification({ userId: "bad id with spaces", kind: "system", title: "x" }),
  );
  await assert.rejects(
    () => createNotification({ userId: USER, kind: "system", title: "   " }),
  );
});

test("emitNotification swallows errors and returns null", async () => {
  const out = await emitNotification({ userId: "bad id", kind: "system", title: "x" });
  assert.equal(out, null);
});

test("inbox is capped at MAX_PER_USER", async () => {
  await clearAll(USER);
  const total = MAX_PER_USER + 5;
  for (let i = 0; i < total; i += 1) {
    await createNotification({ userId: USER, kind: "system", title: `n${i}` });
  }
  const list = await listNotifications(USER, { limit: MAX_PER_USER });
  assert.equal(list.length, MAX_PER_USER);
  // Newest one survives, oldest five are trimmed.
  assert.equal(list[0].title, `n${total - 1}`);
  assert.equal(list[list.length - 1].title, `n5`);
});

test("href is required to be relative", async () => {
  await clearAll(USER);
  const rec = await createNotification({
    userId: USER,
    kind: "share.created",
    title: "x",
    href: "https://evil.example.com",
  });
  assert.equal(rec.href, undefined);
  const ok = await createNotification({
    userId: USER,
    kind: "share.created",
    title: "y",
    href: "/r/abc",
  });
  assert.equal(ok.href, "/r/abc");
});

test("isNotificationId guards id shape", () => {
  assert.equal(isNotificationId("abcdef1234"), true);
  assert.equal(isNotificationId(""), false);
  assert.equal(isNotificationId("../etc/passwd"), false);
  assert.equal(isNotificationId(123 as unknown as string), false);
});
