/**
 * Canonical POST /v1/keys/:id/rotate. Thin re-export of the POST
 * handler at /v1/keys/:id so customers can wire either path into
 * their rotation bot. The route file at /v1/keys/:id documents the
 * full contract, scopes, and audit shape.
 */
export { POST } from "../route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
