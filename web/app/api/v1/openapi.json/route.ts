/**
 * Public GET /v1/openapi.json: unauthenticated, machine-readable
 * OpenAPI 3.1 document for the entire /v1 API surface.
 *
 * Why this is its own route
 * -------------------------
 * Enterprise customers, API gateway operators (Kong, AWS API Gateway,
 * Apigee), and SDK generators (openapi-generator, Stainless, Speakeasy)
 * all expect to fetch an OpenAPI document over HTTP, not run a build
 * script. /v1/discovery is our richer custom manifest; /v1/openapi.json
 * is the standards-compliant view the procurement checklist asks for.
 *
 * The document is generated from the same ENDPOINTS table that powers
 * /docs and /v1/discovery (asserted by tests/docs.test.ts and
 * tests/openapi.test.ts), so it cannot drift from the real routes.
 * Cached 60s so unauthenticated scanners do not hammer the process.
 */
import { NextResponse } from "next/server";
import { buildOpenApi } from "../../../../lib/openapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const host = `${url.protocol}//${url.host}`;
  const doc = buildOpenApi(host);
  return NextResponse.json(doc, {
    headers: {
      "Cache-Control": "public, max-age=60",
      "X-CodeClone-API": "v1",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
