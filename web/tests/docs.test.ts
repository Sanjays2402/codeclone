import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ENDPOINTS, allReferencedScopes } from "../lib/api-spec.ts";
import { ALL_SCOPES, SCOPE_DESCRIPTIONS } from "../lib/api-keys.ts";
import * as scopesModule from "../lib/scopes.ts";

const WEB_ROOT = path.resolve(import.meta.dirname, "..");

test("every documented endpoint maps to a real route file", () => {
  assert.ok(ENDPOINTS.length > 0, "spec should contain at least one endpoint");
  for (const ep of ENDPOINTS) {
    const abs = path.join(WEB_ROOT, ep.routeFile);
    assert.ok(
      fs.existsSync(abs),
      `route file for ${ep.method} ${ep.path} not found at ${ep.routeFile}`,
    );
  }
});

test("every endpoint references a valid scope from lib/api-keys", () => {
  const valid = new Set<string>(ALL_SCOPES);
  for (const ep of ENDPOINTS) {
    assert.ok(
      valid.has(ep.scope),
      `endpoint ${ep.id} references unknown scope "${ep.scope}"`,
    );
    assert.ok(
      SCOPE_DESCRIPTIONS[ep.scope],
      `scope ${ep.scope} is missing a human description`,
    );
  }
});

test("endpoint ids are unique and url-safe", () => {
  const seen = new Set<string>();
  for (const ep of ENDPOINTS) {
    assert.ok(/^[a-z0-9-]+$/.test(ep.id), `id "${ep.id}" must be slug-safe`);
    assert.ok(!seen.has(ep.id), `duplicate endpoint id ${ep.id}`);
    seen.add(ep.id);
  }
});

test("required parameters are well-formed", () => {
  for (const ep of ENDPOINTS) {
    for (const p of ep.params) {
      assert.ok(p.name.length > 0, `${ep.id} param has empty name`);
      assert.ok(
        ["path", "query", "body", "header"].includes(p.kind),
        `${ep.id}.${p.name} has invalid kind ${p.kind}`,
      );
      assert.ok(typeof p.required === "boolean", `${ep.id}.${p.name} required must be boolean`);
      assert.ok(p.type.length > 0 && p.description.length > 0);
    }
  }
});

test("path-templated endpoints declare a matching path param", () => {
  for (const ep of ENDPOINTS) {
    const m = ep.path.match(/\{(\w+)\}/);
    if (!m) continue;
    const name = m[1];
    const hit = ep.params.find((p) => p.kind === "path" && p.name === name);
    assert.ok(hit, `endpoint ${ep.id} has {${name}} in path but no path param declared`);
    assert.ok(hit?.required, `path param ${name} must be required`);
  }
});

test("curl samples reference the documented host, path, and key placeholder", () => {
  for (const ep of ENDPOINTS) {
    const sample = ep.curl("https://example.test", "ck_test_demo");
    assert.match(sample, /^curl /, `${ep.id} curl must start with "curl"`);
    assert.ok(sample.includes("https://example.test"), `${ep.id} curl missing host`);
    assert.ok(
      sample.includes("Authorization: Bearer ck_test_demo"),
      `${ep.id} curl must include Bearer auth header with the provided key`,
    );
    // POST endpoints should include Content-Type and -d
    if (ep.method === "POST") {
      assert.ok(sample.includes("Content-Type: application/json"), `${ep.id} curl missing JSON content-type`);
      assert.ok(sample.includes(" -d "), `${ep.id} POST curl missing body flag`);
    }
  }
});

test("sample responses parse as JSON", () => {
  for (const ep of ENDPOINTS) {
    assert.doesNotThrow(
      () => JSON.parse(ep.sampleResponse),
      `${ep.id} sampleResponse must be valid JSON`,
    );
    if (ep.sampleBody) {
      assert.doesNotThrow(
        () => JSON.parse(ep.sampleBody!),
        `${ep.id} sampleBody must be valid JSON`,
      );
    }
  }
});

test("docs page contains no em-dash in user-visible copy", () => {
  const src = fs.readFileSync(
    path.join(WEB_ROOT, "app/docs/page.tsx"),
    "utf8",
  );
  assert.ok(!src.includes("\u2014"), "docs page must not use em-dash");
});

test("nav bar exposes the docs entry", () => {
  const src = fs.readFileSync(
    path.join(WEB_ROOT, "components/NavBar.tsx"),
    "utf8",
  );
  assert.match(src, /href:\s*"\/docs"/, "NavBar must include /docs link");
});

test("allReferencedScopes returns every scope used by spec", () => {
  const referenced = new Set(allReferencedScopes());
  for (const ep of ENDPOINTS) {
    assert.ok(referenced.has(ep.scope), `allReferencedScopes missing ${ep.scope}`);
  }
});

test("lib/scopes mirrors lib/api-keys scope list and descriptions", () => {
  assert.deepEqual([...scopesModule.ALL_SCOPES], [...ALL_SCOPES]);
  assert.deepEqual(scopesModule.SCOPE_DESCRIPTIONS, SCOPE_DESCRIPTIONS);
});
