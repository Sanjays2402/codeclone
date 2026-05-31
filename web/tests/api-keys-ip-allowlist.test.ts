/**
 * Per-API-key source IP allowlist.
 *
 * Verifies storage + the pure decision function. We avoid importing
 * lib/ip-allowlist-enforce.ts here because it pulls next/server, which
 * does not load under raw `node --test`. The route wires that helper,
 * and the helper is a thin NextResponse wrapper around the pure
 * `evaluateKeyAllowlist` we exercise below.
 *
 * Coverage:
 *   1. createKey persists, dedupes, and rejects junk CIDRs.
 *   2. updateKey replaces, clears (null + []), refuses all-junk patches,
 *      and refuses cross-user mutation.
 *   3. evaluateKeyAllowlist returns "open" when no entries.
 *   4. Non-matching source IP is denied.
 *   5. Matching source IP is allowed.
 *   6. Loopback bypass is intentionally OFF for per-key (different from
 *      workspace level): a locked key must not silently work from 127.0.0.1.
 *   7. Per-key isolation: two keys with different allowlists do not bleed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codeclone-keys-allow-"));
process.env.CODECLONE_KEYS_DIR = tmp;

const { createKey, updateKey, loadKey } = await import("../lib/api-keys.ts");
const { evaluateKeyAllowlist } = await import("../lib/ip-allowlist.ts");

function reqWith(ip: string): Request {
  return new Request("https://api.codeclone.test/v1/compare", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

test("create persists ipAllowlist, dedupes, drops junk", async () => {
  const { record } = await createKey("prod-only", {
    userId: "u1",
    ipAllowlist: ["203.0.113.0/24", "203.0.113.0/24", "garbage", "2001:db8::/32"],
  });
  assert.deepEqual(record.ipAllowlist, ["203.0.113.0/24", "2001:db8::/32"]);
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(tmp, `${record.id}.json`), "utf-8"),
  );
  assert.deepEqual(onDisk.ipAllowlist, ["203.0.113.0/24", "2001:db8::/32"]);
});

test("create with no allowlist leaves field unset (open)", async () => {
  const { record } = await createKey("open", { userId: "u1" });
  assert.equal(record.ipAllowlist, undefined);
});

test("updateKey: set, replace, clear via null, clear via empty array", async () => {
  const { record } = await createKey("rotating", { userId: "u1" });
  let r = await updateKey(record.id, { ipAllowlist: ["10.0.0.0/8"] }, "u1");
  assert.ok(r);
  assert.deepEqual(r!.summary.ipAllowlist, ["10.0.0.0/8"]);
  r = await updateKey(record.id, { ipAllowlist: ["192.168.1.5"] }, "u1");
  assert.deepEqual(r!.summary.ipAllowlist, ["192.168.1.5"]);
  r = await updateKey(record.id, { ipAllowlist: null }, "u1");
  assert.equal(r!.summary.ipAllowlist, undefined);
  await updateKey(record.id, { ipAllowlist: ["10.0.0.0/8"] }, "u1");
  r = await updateKey(record.id, { ipAllowlist: [] }, "u1");
  assert.equal(r!.summary.ipAllowlist, undefined);
});

test("updateKey rejects all-invalid CIDR patch and leaves record untouched", async () => {
  const { record } = await createKey("strict", {
    userId: "u1",
    ipAllowlist: ["203.0.113.0/24"],
  });
  await assert.rejects(
    () => updateKey(record.id, { ipAllowlist: ["not-a-cidr", "999.0.0.0"] }, "u1"),
    /ipAllowlist contained no valid CIDR/,
  );
  const rec = await loadKey(record.id);
  assert.deepEqual(rec!.ipAllowlist, ["203.0.113.0/24"]);
});

test("updateKey refuses cross-user mutation", async () => {
  const { record } = await createKey("u1-key", { userId: "u1" });
  const r = await updateKey(record.id, { ipAllowlist: ["1.2.3.4"] }, "u2");
  assert.equal(r, null);
});

test("evaluateKeyAllowlist: empty list is open", () => {
  const d = evaluateKeyAllowlist(reqWith("8.8.8.8"), undefined);
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "open");
});

test("evaluateKeyAllowlist: non-matching source IP is denied", () => {
  const d = evaluateKeyAllowlist(reqWith("198.51.100.7"), ["203.0.113.0/24"]);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "blocked");
  assert.equal(d.ip, "198.51.100.7");
});

test("evaluateKeyAllowlist: matching source IP is allowed", () => {
  const d = evaluateKeyAllowlist(reqWith("203.0.113.42"), ["203.0.113.0/24"]);
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "match");
});

test("evaluateKeyAllowlist: loopback bypass is OFF for per-key", () => {
  const d = evaluateKeyAllowlist(reqWith("127.0.0.1"), ["203.0.113.0/24"]);
  assert.equal(d.allowed, false, "locked key must not silently work from 127.0.0.1");
  assert.equal(d.reason, "blocked");
});

test("per-key isolation: two keys, two policies, no bleed", async () => {
  const { record: kCi } = await createKey("ci", {
    userId: "u1",
    ipAllowlist: ["203.0.113.0/24"],
  });
  const { record: kProd } = await createKey("prod", {
    userId: "u1",
    ipAllowlist: ["198.51.100.0/24"],
  });
  const ciList = (await loadKey(kCi.id))!.ipAllowlist;
  const prodList = (await loadKey(kProd.id))!.ipAllowlist;

  // CI source IP: accepted by ci key, denied by prod key.
  assert.equal(evaluateKeyAllowlist(reqWith("203.0.113.10"), ciList).allowed, true);
  assert.equal(evaluateKeyAllowlist(reqWith("203.0.113.10"), prodList).allowed, false);

  // Prod source IP: opposite.
  assert.equal(evaluateKeyAllowlist(reqWith("198.51.100.10"), prodList).allowed, true);
  assert.equal(evaluateKeyAllowlist(reqWith("198.51.100.10"), ciList).allowed, false);

  // The plaintext of one key cannot be used to widen the policy of the other:
  // ipAllowlist lives on the persisted record, not on the bearer token.
  assert.notDeepEqual(ciList, prodList);
});
