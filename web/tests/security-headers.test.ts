/**
 * Security headers regression tests.
 *
 * Procurement and security review reject deployments that drop these
 * headers, so they are pinned here. Three layers:
 *
 *  1. `buildSecurityHeaders()` returns the exact baseline we ship.
 *  2. `web/middleware.ts` actually applies that baseline on every
 *     response (verified by source-grep, like the dry-run test pattern).
 *  3. `/.well-known/security.txt` returns an RFC 9116 body with the
 *     required Contact, Expires, and Canonical fields.
 *
 * Run with: node --test --experimental-strip-types web/tests/security-headers.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

const { buildSecurityHeaders, buildSecurityTxt } = await import(
  "../lib/security-headers.ts"
);

test("buildSecurityHeaders: ships the procurement baseline", () => {
  const h = buildSecurityHeaders();

  // Every header an enterprise security questionnaire checks for.
  const required = [
    "Content-Security-Policy",
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Cross-Origin-Opener-Policy",
    "Cross-Origin-Resource-Policy",
  ];
  for (const name of required) {
    assert.ok(h[name], `missing required header: ${name}`);
  }

  // Specific values.
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["X-Frame-Options"], "DENY");
  assert.match(h["Strict-Transport-Security"], /max-age=\d+/);
  assert.match(h["Strict-Transport-Security"], /includeSubDomains/);

  // CSP must lock down ancestors, objects, base, and form-action.
  const csp = h["Content-Security-Policy"];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /form-action 'self'/);

  // Permissions-Policy disables hardware access by default.
  assert.match(h["Permissions-Policy"], /camera=\(\)/);
  assert.match(h["Permissions-Policy"], /microphone=\(\)/);
  assert.match(h["Permissions-Policy"], /geolocation=\(\)/);
});

test("middleware.ts: applies the baseline security headers on every response", () => {
  // Source-grep instead of importing next/server, matching the v1-dry-run
  // test pattern. The middleware must call buildSecurityHeaders and copy
  // every entry onto the response.
  const src = fs.readFileSync(path.join(webRoot, "middleware.ts"), "utf8");
  assert.match(
    src,
    /buildSecurityHeaders/,
    "middleware.ts must import buildSecurityHeaders",
  );
  assert.match(
    src,
    /for \(const \[name, value\] of Object\.entries\(buildSecurityHeaders\(\)\)\)/,
    "middleware.ts must iterate the baseline and set each header",
  );
  assert.match(
    src,
    /res\.headers\.set\(name, value\)/,
    "middleware.ts must actually call res.headers.set",
  );
  // The request id contract from the original middleware must survive.
  assert.match(src, /x-request-id/);
});

test("buildSecurityTxt: RFC 9116 required fields are present", () => {
  const body = buildSecurityTxt(new Date("2026-01-15T12:00:00Z"));
  assert.match(body, /^Contact: /m);
  assert.match(body, /^Expires: 2027-01-15T00:00:00Z$/m);
  assert.match(body, /^Canonical: /m);
  assert.match(body, /^Policy: /m);
  assert.match(body, /^Preferred-Languages: /m);
});

test("/.well-known/security.txt: route delegates to buildSecurityTxt", () => {
  // Source-grep, same reason as the middleware test.
  const routePath = path.join(
    webRoot,
    "app",
    ".well-known",
    "security.txt",
    "route.ts",
  );
  assert.ok(fs.existsSync(routePath), "security.txt route file is missing");
  const src = fs.readFileSync(routePath, "utf8");
  assert.match(src, /buildSecurityTxt/);
  assert.match(src, /text\/plain/);
});

test("/trust page: rendered server-side and lists controls", () => {
  const trustPath = path.join(webRoot, "app", "trust", "page.tsx");
  assert.ok(fs.existsSync(trustPath), "/trust page is missing");
  const src = fs.readFileSync(trustPath, "utf8");
  // Must be a server component (no 'use client').
  assert.ok(
    !src.split("\n").slice(0, 5).join("\n").includes('"use client"'),
    "/trust must be a server component",
  );
  // Must reference key procurement topics.
  for (const topic of [
    "Subprocessors",
    "residency",
    "Vulnerability",
    "audit",
    "SCIM",
    "MFA",
    "buildSecurityHeaders",
  ]) {
    assert.ok(src.includes(topic), `/trust page should mention ${topic}`);
  }
});
