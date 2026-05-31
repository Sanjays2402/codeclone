/**
 * Next.js middleware.
 *
 * Two jobs, both running on every request:
 *
 * 1. Assigns a request id (`X-Request-Id`) so logs, audit entries, and
 *    the client response correlate end to end. Customers see the id in
 *    the response header and can quote it in support tickets.
 *
 * 2. Applies the baseline security headers every enterprise procurement
 *    review asks for. The header set lives in `lib/security-headers.ts`
 *    so tests (and the /trust page) can verify it without pulling in
 *    `next/server`.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildSecurityHeaders } from "./lib/security-headers";

const HEADER = "x-request-id";

function newId(): string {
  const u = crypto.randomUUID().replace(/-/g, "");
  return u.slice(0, 16);
}

export function middleware(req: NextRequest) {
  const incoming = req.headers.get(HEADER);
  const isValid = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming);
  const rid = isValid ? incoming! : newId();

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(HEADER, rid);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set(HEADER, rid);

  // Apply baseline security headers. Safe to set on both HTML and JSON
  // responses because they govern UA behaviour, not the payload format.
  // Route handlers that need to override (rare) can pre-set the header.
  for (const [name, value] of Object.entries(buildSecurityHeaders())) {
    if (!res.headers.has(name)) {
      res.headers.set(name, value);
    }
  }

  return res;
}

export const config = {
  // Run on every request except Next's internal asset endpoints. The
  // .well-known paths are intentionally included so security.txt picks
  // up the headers too.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
