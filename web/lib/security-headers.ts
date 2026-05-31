/**
 * Baseline HTTP security headers shipped on every dashboard and API
 * response. Lives outside `middleware.ts` so tests (and the /trust
 * page) can import it without pulling in `next/server`, which is not
 * loadable under raw `node --test`.
 *
 * The header set is asserted by `tests/security-headers.test.ts` and
 * surfaced to procurement on `/trust`.
 */

/**
 * Return the baseline header map.
 *
 * CSP notes:
 * - `'unsafe-inline'` is currently required for Next.js 16's runtime
 *   chunk loader and inlined style attributes in shadcn primitives.
 *   When we migrate to nonces this can drop.
 * - `connect-src 'self'` keeps the dashboard from talking to third
 *   party hosts; the serve API is reached via same-origin /v1/* rewrite.
 * - `frame-ancestors 'none'` matches `X-Frame-Options: DENY` for old UAs.
 */
export function buildSecurityHeaders(): Record<string, string> {
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");

  return {
    "Content-Security-Policy": csp,
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": [
      "accelerometer=()",
      "autoplay=()",
      "camera=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "payment=()",
      "usb=()",
      "interest-cohort=()",
    ].join(", "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-DNS-Prefetch-Control": "off",
  };
}

/**
 * Build the RFC 9116 security.txt body. Pure function so the route
 * handler stays a one-liner and the test can verify the fields without
 * Next at all.
 */
export function buildSecurityTxt(now: Date = new Date()): string {
  const expires = new Date(now);
  expires.setUTCFullYear(expires.getUTCFullYear() + 1);
  expires.setUTCHours(0, 0, 0, 0);
  const expiresIso = expires.toISOString().replace(/\.\d{3}Z$/, "Z");

  return [
    "# CodeClone security disclosure policy",
    "# See https://www.rfc-editor.org/rfc/rfc9116",
    "",
    "Contact: https://github.com/Sanjays2402/codeclone/security/advisories/new",
    "Contact: mailto:security@codeclone.dev",
    `Expires: ${expiresIso}`,
    "Preferred-Languages: en",
    "Canonical: https://codeclone.dev/.well-known/security.txt",
    "Policy: https://github.com/Sanjays2402/codeclone/blob/main/SECURITY.md",
    "Acknowledgments: https://codeclone.dev/trust",
    "",
  ].join("\n");
}
