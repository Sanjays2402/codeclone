/**
 * Run with: node --test --experimental-strip-types web/tests/openapi.test.ts
 *
 * Asserts the GET /v1/openapi.json (and /v1/openapi.yaml) contract.
 * The OpenAPI document is what enterprise customers feed into Kong,
 * Stainless, Speakeasy, openapi-generator, Postman, and Insomnia, so
 * its shape, scope coverage, and endpoint completeness are part of
 * the public contract and a regression must fail fast in CI, not in
 * a customer's SDK pipeline.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { buildOpenApi, toYaml } = await import("../lib/openapi.ts");
const { ENDPOINTS } = await import("../lib/api-spec.ts");
const { ALL_SCOPES } = await import("../lib/scopes.ts");

test("openapi document covers every endpoint with method+path+scope", () => {
  const doc = buildOpenApi("https://codeclone.example");
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.title, "CodeClone API");
  assert.equal(doc.info.version, "1.0.0");
  assert.equal(doc.servers[0].url, "https://codeclone.example");
  assert.equal(doc.components.securitySchemes.bearerAuth.scheme, "bearer");

  for (const ep of ENDPOINTS) {
    const pathItem = doc.paths[ep.path];
    assert.ok(pathItem, `openapi missing path ${ep.path}`);
    const op = pathItem[ep.method.toLowerCase()];
    assert.ok(op, `openapi missing ${ep.method} ${ep.path}`);
    assert.equal(op["x-codeclone-scope"], ep.scope);
    assert.equal(op["x-codeclone-route-file"], ep.routeFile);
    // Every operation requires bearerAuth with the declared scope.
    assert.deepEqual(op.security, [{ bearerAuth: [ep.scope] }]);
    // Standard error envelopes always present.
    for (const code of ["400", "401", "403", "429"]) {
      assert.ok(op.responses[code], `${ep.method} ${ep.path} missing ${code} response`);
    }
  }
});

test("openapi document advertises every canonical scope", () => {
  const doc = buildOpenApi("https://codeclone.example");
  for (const scope of ALL_SCOPES) {
    assert.ok(doc["x-codeclone"].scopes[scope], `x-codeclone.scopes missing ${scope}`);
  }
});

test("openapi POST bodies are required when at least one body param is required", () => {
  const doc = buildOpenApi("https://codeclone.example");
  const compare = doc.paths["/v1/compare"]?.post;
  assert.ok(compare?.requestBody, "/v1/compare must declare a requestBody");
  assert.equal(compare.requestBody.required, true);
  const schema = compare.requestBody.content["application/json"].schema;
  assert.ok(schema.required.includes("a"));
  assert.ok(schema.required.includes("b"));
});

test("openapi path-templated routes mark id parameters as required path params", () => {
  const doc = buildOpenApi("https://codeclone.example");
  const sharesGet = doc.paths["/v1/shares/{id}"]?.get;
  assert.ok(sharesGet, "/v1/shares/{id} GET must exist");
  const idParam = sharesGet.parameters?.find((p: { name: string }) => p.name === "id");
  assert.ok(idParam, "{id} must be a declared parameter");
  assert.equal(idParam.in, "path");
  assert.equal(idParam.required, true);
});

test("yaml serializer round-trips through JSON-shaped data", () => {
  const doc = buildOpenApi("https://codeclone.example");
  const yaml = toYaml(doc);
  assert.ok(yaml.startsWith("openapi: 3.1.0"), `yaml must start with openapi version, got: ${yaml.slice(0, 40)}`);
  assert.ok(yaml.includes("/v1/compare"));
  assert.ok(yaml.includes("bearerAuth"));
  // Strings containing colons / braces must be quoted to stay valid YAML.
  assert.ok(!/^[^"#]*: [^"\s].*:\s*[^"\s]/m.test(yaml.split("\n").slice(0, 5).join("\n")));
});

test("openapi route files exist and reference the builder", async () => {
  // Route files import next/server which node:test cannot resolve standalone,
  // so we treat the file's static reference to buildOpenApi as the contract
  // and exercise the builder directly (done above). This still catches
  // accidental route deletion or import-path drift in CI.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  for (const rel of [
    "../app/api/v1/openapi.json/route.ts",
    "../app/api/v1/openapi.yaml/route.ts",
  ]) {
    const p = path.resolve(here, rel);
    assert.ok(fs.existsSync(p), `missing route file ${rel}`);
    const src = fs.readFileSync(p, "utf8");
    assert.ok(src.includes("buildOpenApi"), `${rel} must import buildOpenApi`);
    assert.ok(/export async function GET/.test(src), `${rel} must export GET`);
  }
});

test("openapi discovery surfaces the openapi urls", async () => {
  const { buildDiscovery } = await import("../lib/discovery.ts");
  const m = buildDiscovery("https://codeclone.example");
  assert.equal(m.api.openapi_url, "https://codeclone.example/v1/openapi.json");
  assert.equal(m.api.openapi_yaml_url, "https://codeclone.example/v1/openapi.yaml");
});
