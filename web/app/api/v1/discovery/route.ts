/**
 * Public GET /v1/discovery: unauthenticated, machine-readable manifest of
 * the entire public /v1 API surface.
 *
 * Why this exists
 * ---------------
 * Enterprise procurement, SecOps, and developer-experience teams all need
 * a single canonical document they can fetch without credentials that
 * answers:
 *
 *   - Which endpoints does the /v1 API expose?
 *   - Which OAuth-style scope guards each endpoint?
 *   - Which workspace policies (rate limit, allowlist, residency,
 *     idempotency, audit) apply to /v1 traffic?
 *   - What is the current API version and supported response headers?
 *
 * Without this, every customer security review re-asks the same questions
 * by email. Shipping a discovery manifest collapses that loop and also
 * lets SDK generators and API gateways stay in sync automatically.
 *
 * Contract
 * --------
 * No auth, no scope, no rate-limit, no audit row, no usage row. Output is
 * derived from the same `ENDPOINTS` table that powers /docs (and is
 * itself enforced by tests/docs.test.ts), so the manifest cannot drift
 * from real routes. Cached for 60s so credential-free scanners do not
 * hammer the dashboard process during procurement.
 */
import { NextResponse } from "next/server";
import { buildDiscovery } from "../../../../lib/discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const host = `${url.protocol}//${url.host}`;
  const body = buildDiscovery(host);
  return NextResponse.json(body, {
    headers: {
      "Cache-Control": "public, max-age=60",
      "X-CodeClone-API": "v1",
    },
  });
}
