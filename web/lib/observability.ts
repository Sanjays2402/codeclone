/**
 * Lightweight in-process observability for codeclone.
 *
 * Tracks request counters and a small in-memory latency histogram so the
 * dashboard can expose Prometheus-style metrics and a human status page
 * without pulling in a full APM dependency. Counters survive across hot
 * reloads in dev because we stash them on `globalThis`.
 *
 * Exposition format is Prometheus text format 0.0.4. All metric names use
 * the `codeclone_` prefix so they slot cleanly into a customer's Grafana.
 */
import crypto from "node:crypto";

export const REQUEST_ID_HEADER = "x-request-id";

const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

interface HistogramState {
  counts: number[]; // same length as BUCKETS_MS
  inf: number;
  sum: number;
  count: number;
}

interface MetricsState {
  startedAt: number;
  requestsTotal: Map<string, number>; // "method|route|status"
  inflight: number;
  durations: Map<string, HistogramState>; // "method|route"
  lastRequestAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __codecloneMetrics: MetricsState | undefined;
}

function getState(): MetricsState {
  if (!globalThis.__codecloneMetrics) {
    globalThis.__codecloneMetrics = {
      startedAt: Date.now(),
      requestsTotal: new Map(),
      inflight: 0,
      durations: new Map(),
      lastRequestAt: 0,
    };
  }
  return globalThis.__codecloneMetrics;
}

export function newRequestId(): string {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Normalize a URL path into a low-cardinality route label so we never
 * blow up Prometheus with one series per id. Replaces obvious id-looking
 * segments with `:id` placeholders.
 */
export function normalizeRoute(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  const parts = pathname.split("/").filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (
      // hex / base64url ids, ulids, uuids, our own prefixed ids
      /^(u_|ws_|ak_|inv_|cmp_|sn_|cl_|rn_|sh_|wh_|nf_|ds_|pr_|kp_|run_|btx_)/i.test(p) ||
      /^[0-9a-f]{16,}$/i.test(p) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p) ||
      /^\d+$/.test(p)
    ) {
      out.push(":id");
    } else if (p.length > 48) {
      out.push(":id");
    } else {
      out.push(p);
    }
  }
  return "/" + out.join("/");
}

export function incInflight(): void {
  getState().inflight += 1;
}

export function decInflight(): void {
  const s = getState();
  s.inflight = Math.max(0, s.inflight - 1);
}

export function recordRequest(opts: {
  method: string;
  route: string;
  status: number;
  durationMs?: number;
}): void {
  const s = getState();
  s.lastRequestAt = Date.now();
  const method = opts.method.toUpperCase();
  const route = opts.route || "/";
  const status = String(opts.status || 0);
  const key = `${method}|${route}|${status}`;
  s.requestsTotal.set(key, (s.requestsTotal.get(key) ?? 0) + 1);
  if (typeof opts.durationMs === "number" && Number.isFinite(opts.durationMs)) {
    const hKey = `${method}|${route}`;
    let h = s.durations.get(hKey);
    if (!h) {
      h = { counts: new Array(BUCKETS_MS.length).fill(0), inf: 0, sum: 0, count: 0 };
      s.durations.set(hKey, h);
    }
    h.count += 1;
    h.sum += opts.durationMs;
    let placed = false;
    for (let i = 0; i < BUCKETS_MS.length; i++) {
      if (opts.durationMs <= BUCKETS_MS[i]) {
        for (let j = i; j < BUCKETS_MS.length; j++) h.counts[j] += 1;
        placed = true;
        break;
      }
    }
    if (!placed) h.inf += 1;
  }
}

export interface MetricsSnapshot {
  startedAt: number;
  uptimeSec: number;
  inflight: number;
  totalRequests: number;
  lastRequestAt: number;
  byRoute: Array<{ method: string; route: string; status: string; count: number }>;
  latency: Array<{
    method: string;
    route: string;
    count: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
  }>;
}

function percentileFromHistogram(h: HistogramState, p: number): number {
  if (h.count === 0) return 0;
  const target = Math.ceil((p / 100) * h.count);
  for (let i = 0; i < BUCKETS_MS.length; i++) {
    if (h.counts[i] >= target) return BUCKETS_MS[i];
  }
  return BUCKETS_MS[BUCKETS_MS.length - 1];
}

export function snapshot(): MetricsSnapshot {
  const s = getState();
  let total = 0;
  const byRoute: MetricsSnapshot["byRoute"] = [];
  for (const [key, count] of s.requestsTotal) {
    total += count;
    const [method, route, status] = key.split("|");
    byRoute.push({ method, route, status, count });
  }
  byRoute.sort((a, b) => b.count - a.count);
  const latency: MetricsSnapshot["latency"] = [];
  for (const [key, h] of s.durations) {
    const [method, route] = key.split("|");
    latency.push({
      method,
      route,
      count: h.count,
      avgMs: h.count ? Math.round((h.sum / h.count) * 10) / 10 : 0,
      p50Ms: percentileFromHistogram(h, 50),
      p95Ms: percentileFromHistogram(h, 95),
    });
  }
  latency.sort((a, b) => b.count - a.count);
  return {
    startedAt: s.startedAt,
    uptimeSec: Math.floor((Date.now() - s.startedAt) / 1000),
    inflight: s.inflight,
    totalRequests: total,
    lastRequestAt: s.lastRequestAt,
    byRoute,
    latency,
  };
}

/**
 * Prometheus text format 0.0.4 exposition.
 * https://prometheus.io/docs/instrumenting/exposition_formats/
 */
export function renderPrometheus(): string {
  const s = getState();
  const lines: string[] = [];

  lines.push("# HELP codeclone_build_info Static build info as labels");
  lines.push("# TYPE codeclone_build_info gauge");
  lines.push(`codeclone_build_info{service="codeclone-dashboard",version="0.2.0"} 1`);

  lines.push("# HELP codeclone_process_start_time_seconds Process start time, unix seconds");
  lines.push("# TYPE codeclone_process_start_time_seconds gauge");
  lines.push(`codeclone_process_start_time_seconds ${(s.startedAt / 1000).toFixed(3)}`);

  lines.push("# HELP codeclone_http_requests_inflight In-flight HTTP requests");
  lines.push("# TYPE codeclone_http_requests_inflight gauge");
  lines.push(`codeclone_http_requests_inflight ${s.inflight}`);

  lines.push("# HELP codeclone_http_requests_total Total HTTP requests handled");
  lines.push("# TYPE codeclone_http_requests_total counter");
  for (const [key, count] of s.requestsTotal) {
    const [method, route, status] = key.split("|");
    lines.push(
      `codeclone_http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${escapeLabel(status)}"} ${count}`,
    );
  }

  lines.push("# HELP codeclone_http_request_duration_ms HTTP request latency in ms");
  lines.push("# TYPE codeclone_http_request_duration_ms histogram");
  for (const [key, h] of s.durations) {
    const [method, route] = key.split("|");
    const labelBase = `method="${escapeLabel(method)}",route="${escapeLabel(route)}"`;
    for (let i = 0; i < BUCKETS_MS.length; i++) {
      lines.push(
        `codeclone_http_request_duration_ms_bucket{${labelBase},le="${BUCKETS_MS[i]}"} ${h.counts[i]}`,
      );
    }
    lines.push(`codeclone_http_request_duration_ms_bucket{${labelBase},le="+Inf"} ${h.count}`);
    lines.push(`codeclone_http_request_duration_ms_sum{${labelBase}} ${h.sum.toFixed(3)}`);
    lines.push(`codeclone_http_request_duration_ms_count{${labelBase}} ${h.count}`);
  }

  return lines.join("\n") + "\n";
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Test-only reset. */
export function __resetMetricsForTests(): void {
  globalThis.__codecloneMetrics = undefined;
}
