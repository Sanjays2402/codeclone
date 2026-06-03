"use client";

import useSWR from "swr";
import { Heartbeat, Pulse, Gauge, Activity, ArrowsClockwise, DownloadSimple } from "@phosphor-icons/react/dist/ssr";
import { H1, H2 } from "../../components/Headings";
import { Empty, ErrorBlock, LoadingRow } from "../../components/States";
import { fmtInt, fmtTs } from "../../lib/format";

interface Snapshot {
  startedAt: number;
  uptimeSec: number;
  inflight: number;
  totalRequests: number;
  lastRequestAt: number;
  byRoute: Array<{ method: string; route: string; status: string; count: number }>;
  latency: Array<{ method: string; route: string; count: number; avgMs: number; p50Ms: number; p95Ms: number }>;
}

const fetcher = (u: string) => fetch(u).then((r) => {
  if (!r.ok) throw new Error("snapshot_failed");
  return r.json() as Promise<Snapshot>;
});

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function statusTone(status: string): string {
  const n = Number(status);
  if (n >= 500) return "text-[var(--color-neg)]";
  if (n >= 400) return "text-[color:var(--color-warn,#b85c00)]";
  if (n >= 300) return "text-[var(--color-ink-2)]";
  return "text-[var(--color-pos,inherit)]";
}

export default function StatusPage() {
  const { data, error, isLoading, mutate } = useSWR<Snapshot>(
    "/api/observability/snapshot",
    fetcher,
    { refreshInterval: 5000 },
  );

  return (
    <main className="max-w-5xl mx-auto px-5 sm:px-8 py-10">
      <H1 eyebrow="observability">Status</H1>
      <p className="text-[14px] text-[var(--color-ink-2)] -mt-3 mb-6 max-w-[60ch]">
        Live counters for this dashboard process. Prometheus scrape endpoint is at
        {" "}
        <a className="underline underline-offset-2" href="/api/metrics">/api/metrics</a>.
        Liveness at <a className="underline underline-offset-2" href="/api/healthz">/api/healthz</a>,
        readiness at <a className="underline underline-offset-2" href="/api/readyz">/api/readyz</a>.
      </p>

      {error && <ErrorBlock message="Could not load metrics snapshot." />}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <Tile icon={<Heartbeat weight="duotone" />} label="Uptime"
              value={data ? fmtUptime(data.uptimeSec) : "—"} loading={isLoading} />
        <Tile icon={<Pulse weight="duotone" />} label="Requests"
              value={data ? fmtInt(data.totalRequests) : "—"} loading={isLoading} />
        <Tile icon={<Activity weight="duotone" />} label="In flight"
              value={data ? String(data.inflight) : "—"} loading={isLoading} />
        <Tile icon={<Gauge weight="duotone" />} label="Last request"
              value={data?.lastRequestAt ? fmtTs(data.lastRequestAt) : "never"} loading={isLoading} />
      </div>

      <div className="flex items-center justify-between">
        <H2 eyebrow="latency">By route</H2>
        <div className="flex items-center gap-4">
          <a
            href="/api/observability/snapshot?format=csv"
            download="codeclone-status.csv"
            className="text-[12.5px] text-[var(--color-ink-2)] hover:text-[var(--color-ink-1)] inline-flex items-center gap-1.5"
            title="Snapshot per-route latency and status mix as CSV"
          >
            <DownloadSimple weight="duotone" /> Download CSV
          </a>
          <button
            type="button"
            onClick={() => mutate()}
            className="text-[12.5px] text-[var(--color-ink-2)] hover:text-[var(--color-ink-1)] inline-flex items-center gap-1.5"
          >
            <ArrowsClockwise weight="duotone" /> Refresh
          </button>
        </div>
      </div>

      {isLoading && !data && (
        <div className="space-y-2">
          <LoadingRow />
          <LoadingRow />
          <LoadingRow />
        </div>
      )}

      {data && data.latency.length === 0 && (
        <Empty
          title="No traffic recorded yet"
          hint="Hit any instrumented endpoint and metrics will appear within a few seconds."
          mono="curl localhost:3000/api/healthz"
        />
      )}

      {data && data.latency.length > 0 && (
        <div className="ruled rounded-md overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="bg-[var(--color-paper-2)] text-[var(--color-ink-3)]">
              <tr className="text-left">
                <th className="px-4 py-2 font-normal">Method</th>
                <th className="px-4 py-2 font-normal">Route</th>
                <th className="px-4 py-2 font-normal text-right">Count</th>
                <th className="px-4 py-2 font-normal text-right">Avg ms</th>
                <th className="px-4 py-2 font-normal text-right">p50</th>
                <th className="px-4 py-2 font-normal text-right">p95</th>
              </tr>
            </thead>
            <tbody>
              {data.latency.map((row) => (
                <tr key={`${row.method}|${row.route}`} className="border-t border-[var(--color-rule)]">
                  <td className="px-4 py-2 mono text-[12px] text-[var(--color-ink-2)]">{row.method}</td>
                  <td className="px-4 py-2 mono text-[12px]">{row.route}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtInt(row.count)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{row.avgMs}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{row.p50Ms}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{row.p95Ms}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.byRoute.length > 0 && (
        <>
          <H2 eyebrow="status">Responses by status</H2>
          <div className="ruled rounded-md overflow-hidden">
            <table className="w-full text-[13px]">
              <thead className="bg-[var(--color-paper-2)] text-[var(--color-ink-3)]">
                <tr className="text-left">
                  <th className="px-4 py-2 font-normal">Method</th>
                  <th className="px-4 py-2 font-normal">Route</th>
                  <th className="px-4 py-2 font-normal">Status</th>
                  <th className="px-4 py-2 font-normal text-right">Count</th>
                </tr>
              </thead>
              <tbody>
                {data.byRoute.map((row) => (
                  <tr key={`${row.method}|${row.route}|${row.status}`} className="border-t border-[var(--color-rule)]">
                    <td className="px-4 py-2 mono text-[12px] text-[var(--color-ink-2)]">{row.method}</td>
                    <td className="px-4 py-2 mono text-[12px]">{row.route}</td>
                    <td className={`px-4 py-2 mono text-[12px] ${statusTone(row.status)}`}>{row.status}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmtInt(row.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}

function Tile({
  icon, label, value, loading,
}: {
  icon: React.ReactNode; label: string; value: string; loading?: boolean;
}) {
  return (
    <div className="ruled rounded-md px-4 py-3">
      <div className="flex items-center gap-1.5 text-[var(--color-ink-3)] text-[11.5px] uppercase tracking-[0.12em] mb-1">
        <span className="text-[14px]">{icon}</span>
        {label}
      </div>
      <div className="text-[20px] tabular-nums">
        {loading ? <span className="text-[var(--color-ink-3)]">…</span> : value}
      </div>
    </div>
  );
}
