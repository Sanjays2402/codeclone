/**
 * Next.js middleware.
 *
 * Assigns a request id to every request so logs, audit entries, and the
 * client response can be correlated end to end. Customers see the id in
 * the `X-Request-Id` response header and can quote it in support tickets.
 *
 * Runs on the Edge runtime, so we keep this dependency-free.
 */
import { NextRequest, NextResponse } from "next/server";

const HEADER = "x-request-id";

function newId(): string {
  // crypto.randomUUID is available on the Edge runtime.
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
  return res;
}

export const config = {
  // Run on every request except Next's internal asset endpoints.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
