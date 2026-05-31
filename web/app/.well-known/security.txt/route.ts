/**
 * RFC 9116 security.txt at /.well-known/security.txt.
 *
 * Body is built by `lib/security-headers.ts::buildSecurityTxt` so the
 * test can verify the contents without importing this route.
 */
import { NextResponse } from "next/server";
import { buildSecurityTxt } from "../../../lib/security-headers";

export const dynamic = "force-static";
export const revalidate = 86400;

export function GET(): NextResponse {
  return new NextResponse(buildSecurityTxt(), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
