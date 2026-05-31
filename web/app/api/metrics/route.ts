/**
 * Prometheus exposition endpoint.
 *
 * Scrape with:
 *   - job_name: codeclone
 *     metrics_path: /api/metrics
 *     static_configs: [{ targets: ["dashboard:3000"] }]
 *
 * Counters are in-process; for multi-replica deploys point each replica at
 * its own scrape target (or front them with the OpenTelemetry collector).
 */
import { instrument } from "../../../lib/instrument";
import { renderPrometheus } from "../../../lib/observability";

export const dynamic = "force-dynamic";

export const GET = instrument("/api/metrics", async () => {
  const body = renderPrometheus();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    },
  });
});
