/**
 * Liveness probe. Returns 200 as long as the process is up. No deps.
 * Cheap enough for Kubernetes / load-balancer health checks.
 */
import { NextResponse } from "next/server";
import { instrument } from "../../../lib/instrument";

export const dynamic = "force-dynamic";

export const GET = instrument("/api/healthz", async () => {
  return NextResponse.json(
    {
      status: "ok",
      service: "codeclone-dashboard",
      version: "0.2.0",
      time: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
});
