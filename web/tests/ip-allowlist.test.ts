/**
 * Workspace IP allowlist: CIDR parsing, matching, and enforcement decision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const ip = await import("../lib/ip-allowlist.ts");

test("parseCidr accepts IPv4 with and without mask", () => {
  assert.equal(ip.parseCidr("203.0.113.5")?.prefix, 32);
  const c = ip.parseCidr("203.0.113.0/24");
  assert.ok(c);
  assert.equal(c!.family, 4);
  assert.equal(c!.prefix, 24);
});

test("parseCidr rejects junk and out-of-range", () => {
  assert.equal(ip.parseCidr("not-an-ip"), null);
  assert.equal(ip.parseCidr("256.0.0.1"), null);
  assert.equal(ip.parseCidr("10.0.0.0/40"), null);
  assert.equal(ip.parseCidr(""), null);
  assert.equal(ip.parseCidr(123 as unknown as string), null);
});

test("parseCidr handles IPv6 and short forms", () => {
  const c = ip.parseCidr("2001:db8::/32");
  assert.ok(c);
  assert.equal(c!.family, 6);
  assert.equal(c!.prefix, 32);
  const loop = ip.parseCidr("::1");
  assert.ok(loop);
  assert.equal(loop!.prefix, 128);
});

test("matchCidr admits in-range and rejects out-of-range IPv4", () => {
  const c = [ip.parseCidr("203.0.113.0/24")!];
  assert.equal(ip.matchCidr("203.0.113.7", c), true);
  assert.equal(ip.matchCidr("203.0.113.255", c), true);
  assert.equal(ip.matchCidr("203.0.114.1", c), false);
  assert.equal(ip.matchCidr("10.0.0.1", c), false);
});

test("matchCidr handles IPv6 prefixes", () => {
  const c = [ip.parseCidr("2001:db8::/32")!];
  assert.equal(ip.matchCidr("2001:db8::1", c), true);
  assert.equal(ip.matchCidr("2001:db8:dead:beef::1", c), true);
  assert.equal(ip.matchCidr("2001:db9::1", c), false);
});

test("sanitizeCidrList dedupes, drops invalid, preserves order", () => {
  const { ok, rejected } = ip.sanitizeCidrList([
    "10.0.0.0/8",
    "10.0.0.0/8",      // dup
    "not-a-cidr",
    "192.168.0.0/16",
    42,
  ]);
  assert.deepEqual(ok, ["10.0.0.0/8", "192.168.0.0/16"]);
  assert.deepEqual(rejected, ["not-a-cidr", "42"]);
});

test("evaluateAllowlist: empty list is open", () => {
  const req = new Request("http://x/", { headers: { "x-forwarded-for": "8.8.8.8" } });
  const d = ip.evaluateAllowlist(req, []);
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "open");
});

test("evaluateAllowlist: loopback always permitted", () => {
  const req = new Request("http://x/", { headers: { "x-forwarded-for": "127.0.0.1" } });
  const d = ip.evaluateAllowlist(req, ["10.0.0.0/8"]);
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "loopback");
});

test("evaluateAllowlist: blocks IP not in any CIDR", () => {
  const req = new Request("http://x/", { headers: { "x-forwarded-for": "8.8.8.8" } });
  const d = ip.evaluateAllowlist(req, ["10.0.0.0/8", "203.0.113.0/24"]);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "blocked");
  assert.equal(d.ip, "8.8.8.8");
});

test("evaluateAllowlist: admits matching IP", () => {
  const req = new Request("http://x/", { headers: { "x-forwarded-for": "203.0.113.42, 10.0.0.1" } });
  const d = ip.evaluateAllowlist(req, ["203.0.113.0/24"]);
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "match");
});

test("evaluateAllowlist: missing IP with rules is denied", () => {
  const req = new Request("http://x/");
  const d = ip.evaluateAllowlist(req, ["10.0.0.0/8"]);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "no_ip");
});
