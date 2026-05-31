/**
 * Server-side instrumentation wrapper for Route Handlers.
 *
 * Wrap a Next.js route handler with `instrument("route_label", handler)` to
 * count requests, record latency, and emit a one-line structured JSON log.
 * The request id from middleware (X-Request-Id) is propagated to the
 * response and the log line.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  REQUEST_ID_HEADER,
  decInflight,
  incInflight,
  newRequestId,
  recordRequest,
} from "./observability";

type HandlerReq = Request | NextRequest;
type Handler = (req: HandlerReq, ctx?: unknown) => Promise<Response> | Response;

function getRid(req: HandlerReq): string {
  const r = req.headers.get(REQUEST_ID_HEADER);
  if (r && /^[A-Za-z0-9._-]{8,64}$/.test(r)) return r;
  return newRequestId();
}

export function instrument(route: string, handler: Handler): Handler {
  return async (req, ctx) => {
    const start = Date.now();
    const rid = getRid(req);
    incInflight();
    let status = 500;
    try {
      const res = (await handler(req, ctx)) as Response;
      status = res.status;
      // Stamp the request id on the way out in case the handler built a
      // fresh Response without copying headers.
      try {
        if (!res.headers.get(REQUEST_ID_HEADER)) {
          res.headers.set(REQUEST_ID_HEADER, rid);
        }
      } catch {
        // Some Response objects are immutable; ignore.
      }
      return res;
    } catch (err) {
      status = 500;
      const body = {
        error: "internal_error",
        request_id: rid,
      };
      // Structured error log
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          level: "error",
          ts: new Date().toISOString(),
          msg: "route_unhandled_error",
          route,
          method: req.method,
          request_id: rid,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
      return NextResponse.json(body, {
        status: 500,
        headers: { [REQUEST_ID_HEADER]: rid },
      });
    } finally {
      const dur = Date.now() - start;
      decInflight();
      recordRequest({ method: req.method, route, status, durationMs: dur });
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          level: "info",
          ts: new Date().toISOString(),
          msg: "http_request",
          route,
          method: req.method,
          status,
          duration_ms: dur,
          request_id: rid,
        }),
      );
    }
  };
}
