"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  ChartLineUp,
  Gauge,
  Sparkle,
  Lightning,
  Key,
  ArrowRight,
  PlugsConnected,
  Pulse,
  ArrowsClockwise,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { H1, H2 } from "../../components/Headings";
import { Empty, ErrorBlock, LoadingRow } from "../../components/States";
import { fmtInt, fmtTs } from "../../lib/format";

interface DailyUsage { date: string; count: number }
interface KeyUsage { keyId: string; count: number }
interface EndpointUsage {
  endpoint: string;
  count: number;
  avgLatencyMs: number | null;
  totalBytes: number;
}
interface UsageSummary {
  windowDays: number;
  totalCalls: number;
  monthToDate: number;
  freeTierMonthly: number;
  quotaRemaining: number;
  quotaPercent: number;
  byDay: DailyUsage[];
  byKey: KeyUsage[];
  byEndpoint: EndpointUsage[];
  lastEventAt: number | null;
}
interface RecentCall {
  ts: number;
  keyId: string;
  endpoint: string;
  bytes?: number;
  latencyMs?: number;
}
interface RecentResponse {
  events: RecentCall[];
  limit: number;
  windowDays: number;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtRel(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j?.error?.message ?? `Request failed (${res.status}).`);
  }
  return (await res.json()) as UsageSummary;
};

function classifyQuota(pct: number): { tone: string; label: string } {
  if (pct >= 90) return { tone: "var(--color-neg)", label: "Limit near" };
  if (pct >= 60) return { tone: "var(--color-warn, #b6822a)", label: "Watch" };
  return { tone: "var(--color-pos, #2f7a45)", label: "Healthy" };
}

function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <div
      className="h-2 rounded-full bg-[var(--color-paper-3)] overflow-hidden"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full transition-all"
        style={{ width: `${Math.max(2, Math.min(100, pct))}%`, background: tone }}
      />
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length === 0) return null;
  const max = Math.max(1, ...values);
  const w = 100;
  const h = 32;
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values
    .map((v, i) => `${(i * step).toFixed(2)},${(h - (v / max) * (h - 2) - 1).toFixed(2)}`)
    .join(" ");
  const last = values.length - 1;
  const lx = last * step;
  const ly = h - (values[last] / max) * (h - 2) - 1;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-8" preserveAspectRatio="none" aria-hidden>
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={pts}
      />
      <circle cx={lx} cy={ly} r="1.6" fill="currentColor" />
    </svg>
  );
}

function DailyBars({ days }: { days: DailyUsage[] }) {
  const max = Math.max(1, ...days.map((d) => d.count));
  return (
    <div className="ruled rounded-md p-4">
      <div className="flex items-end gap-[3px] h-32">
        {days.map((d) => {
          const h = (d.count / max) * 100;
          return (
            <div
              key={d.date}
              className="flex-1 min-w-[3px] bg-[var(--color-ink-4)] rounded-sm hover:bg-[var(--color-ink-2)] transition-colors"
              style={{ height: `${Math.max(2, h)}%`, opacity: d.count === 0 ? 0.25 : 1 }}
              title={`${d.date}: ${d.count} calls`}
            />
          );
        })}
      </div>
      <div className="mt-2 flex justify-between mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
        <span>{days[0]?.date ?? ""}</span>
        <span>{days[days.length - 1]?.date ?? ""}</span>
      </div>
    </div>
  );
}

export default function UsagePage() {
  const [days, setDays] = useState(30);
  const { data, error, isLoading, mutate } = useSWR<UsageSummary>(
    `/api/usage?days=${days}`,
    fetcher,
    { refreshInterval: 30_000 },
  );

  useEffect(() => {
    void mutate();
  }, [days, mutate]);

  const quota = useMemo(() => classifyQuota(data?.quotaPercent ?? 0), [data]);

  return (
    <main className="mx-auto max-w-[1280px] px-7 py-10">
      <H1 eyebrow="Account">Usage</H1>
      <p className="text-[14px] text-[var(--color-ink-3)] max-w-[640px] -mt-3 mb-6">
        Track API calls against your free tier quota. Counters reset on the first of each calendar month UTC.
      </p>

      {error && <ErrorBlock message={(error as Error).message} />}
      {isLoading && !data && <LoadingRow rows={4} />}

      {data && (
        <>
          <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="ruled rounded-md p-5">
              <div className="flex items-center gap-2 mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] mb-2">
                <Gauge size={14} weight="duotone" /> Month to date
              </div>
              <div className="flex items-baseline gap-2">
                <div className="text-[28px] font-medium tracking-tight">{fmtInt(data.monthToDate)}</div>
                <div className="mono text-[11px] text-[var(--color-ink-3)]">/ {fmtInt(data.freeTierMonthly)}</div>
              </div>
              <div className="mt-3">
                <Bar pct={data.quotaPercent} tone={quota.tone} />
                <div className="mt-1.5 flex justify-between mono text-[10.5px] uppercase tracking-[0.14em]">
                  <span style={{ color: quota.tone }}>{quota.label}</span>
                  <span className="text-[var(--color-ink-3)]">{data.quotaPercent.toFixed(1)}%</span>
                </div>
              </div>
            </div>

            <div className="ruled rounded-md p-5">
              <div className="flex items-center gap-2 mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] mb-2">
                <ChartLineUp size={14} weight="duotone" /> Last {data.windowDays} days
              </div>
              <div className="text-[28px] font-medium tracking-tight">{fmtInt(data.totalCalls)}</div>
              <div className="mt-3 text-[var(--color-ink-2)]">
                <Sparkline values={data.byDay.map((d) => d.count)} />
              </div>
              <div className="mt-1 mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
                Last call {fmtTs(data.lastEventAt)}
              </div>
            </div>

            <div className="ruled rounded-md p-5 bg-[var(--color-paper-2)]">
              <div className="flex items-center gap-2 mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] mb-2">
                <Sparkle size={14} weight="duotone" /> Upgrade
              </div>
              <div className="text-[15px] font-medium tracking-tight mb-1">Need more calls?</div>
              <p className="text-[12.5px] text-[var(--color-ink-3)] mb-3">
                Pro lifts the cap to 50k requests per month, adds priority queueing, and unlocks batch CSV uploads.
              </p>
              <a
                href="mailto:hello@codeclone.dev?subject=codeclone%20pro"
                className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm bg-[var(--color-ink)] text-[var(--color-paper)] hover:opacity-90"
              >
                <Lightning size={12} weight="fill" /> Talk to us <ArrowRight size={12} weight="bold" />
              </a>
            </div>
          </section>

          <H2
            eyebrow="Daily"
            right={
              <div className="flex items-center gap-1" role="tablist" aria-label="Window">
                {[7, 30, 90].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setDays(n)}
                    aria-pressed={days === n}
                    className={`mono text-[10.5px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border ${
                      days === n
                        ? "bg-[var(--color-paper-3)] border-[var(--color-rule)] text-[var(--color-ink)]"
                        : "border-transparent text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
                    }`}
                  >
                    {n}d
                  </button>
                ))}
              </div>
            }
          >
            Calls per day
          </H2>
          <DailyBars days={data.byDay} />

          <H2 eyebrow="Endpoints">By endpoint</H2>
          {data.byEndpoint.length === 0 ? (
            <Empty
              title="No endpoint traffic yet"
              hint="Calls to /v1/* will be grouped here with average latency and total bytes."
            />
          ) : (
            <div className="ruled rounded-md overflow-hidden">
              <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 px-4 py-2 mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] bg-[var(--color-paper-2)]">
                <div>Endpoint</div>
                <div className="text-right">Calls</div>
                <div className="text-right">Avg latency</div>
                <div className="text-right">Bytes in</div>
                <div className="text-right w-40">Share</div>
              </div>
              {data.byEndpoint.map((e) => {
                const share = data.totalCalls
                  ? (e.count / data.totalCalls) * 100
                  : 0;
                return (
                  <div
                    key={e.endpoint}
                    className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 px-4 py-2.5 border-t border-[var(--color-rule)] items-center"
                  >
                    <div className="mono text-[12px] text-[var(--color-ink)] inline-flex items-center gap-1.5">
                      <PlugsConnected size={12} weight="duotone" />
                      {e.endpoint}
                    </div>
                    <div className="text-right mono text-[12px] tabular-nums">{fmtInt(e.count)}</div>
                    <div className="text-right mono text-[12px] tabular-nums text-[var(--color-ink-3)]">
                      {e.avgLatencyMs == null ? "—" : `${e.avgLatencyMs.toFixed(1)} ms`}
                    </div>
                    <div className="text-right mono text-[12px] tabular-nums text-[var(--color-ink-3)]">
                      {fmtBytes(e.totalBytes)}
                    </div>
                    <div className="w-40">
                      <Bar pct={share} tone="var(--color-ink-2)" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <RecentCallsPanel />

          <H2 eyebrow="Keys">By API key</H2>
          {data.byKey.length === 0 ? (
            <Empty
              title="No calls yet"
              hint="Create an API key and POST to /v1/compare to start filling this chart."
              mono="curl -H 'Authorization: Bearer cc_live_...' /v1/compare"
            />
          ) : (
            <div className="ruled rounded-md overflow-hidden">
              <div className="grid grid-cols-[1fr_auto_auto] gap-4 px-4 py-2 mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] bg-[var(--color-paper-2)]">
                <div>Key id</div>
                <div className="text-right">Calls</div>
                <div className="text-right w-40">Share</div>
              </div>
              {data.byKey.map((k) => {
                const share = data.totalCalls
                  ? (k.count / data.totalCalls) * 100
                  : 0;
                return (
                  <div
                    key={k.keyId}
                    className="grid grid-cols-[1fr_auto_auto] gap-4 px-4 py-2.5 border-t border-[var(--color-rule)] items-center"
                  >
                    <Link
                      href="/api-keys"
                      className="mono text-[12px] text-[var(--color-ink)] hover:underline inline-flex items-center gap-1.5"
                    >
                      <Key size={12} weight="duotone" />
                      {k.keyId}
                    </Link>
                    <div className="text-right mono text-[12px] tabular-nums">{fmtInt(k.count)}</div>
                    <div className="w-40">
                      <Bar pct={share} tone="var(--color-ink-2)" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </main>
  );
}

function RecentCallsPanel() {
  const { data, error, isLoading, mutate } = useSWR<RecentResponse>(
    `/api/usage/recent?limit=50&days=7`,
    fetcher as unknown as (url: string) => Promise<RecentResponse>,
    { refreshInterval: 15_000 },
  );
  const now = Date.now();
  return (
    <>
      <H2
        eyebrow="Log"
        right={
          <button
            type="button"
            onClick={() => void mutate()}
            className="mono text-[10.5px] uppercase tracking-[0.14em] px-2 py-1 rounded-sm border border-transparent text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:border-[var(--color-rule)] inline-flex items-center gap-1.5"
            aria-label="Refresh recent calls"
          >
            <ArrowsClockwise size={12} weight="duotone" /> Refresh
          </button>
        }
      >
        Recent API calls
      </H2>
      {error && <ErrorBlock message={(error as Error).message} />}
      {isLoading && !data && <LoadingRow rows={3} />}
      {data && data.events.length === 0 && (
        <Empty
          title="No recent calls"
          hint="Authenticated calls in the last 7 days will appear here, newest first."
          mono="curl -H 'Authorization: Bearer cc_live_...' http://localhost:3000/v1/compare"
        />
      )}
      {data && data.events.length > 0 && (
        <div className="ruled rounded-md overflow-hidden">
          <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-4 px-4 py-2 mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-ink-3)] bg-[var(--color-paper-2)]">
            <div>When</div>
            <div>Endpoint</div>
            <div className="text-right">Key</div>
            <div className="text-right">Latency</div>
            <div className="text-right">Bytes</div>
          </div>
          {data.events.map((ev, i) => (
            <div
              key={`${ev.ts}-${i}`}
              className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-4 px-4 py-2 border-t border-[var(--color-rule)] items-center"
            >
              <div
                className="mono text-[11.5px] text-[var(--color-ink-3)] tabular-nums"
                title={new Date(ev.ts).toISOString()}
              >
                {fmtRel(ev.ts, now)}
              </div>
              <div className="mono text-[12px] text-[var(--color-ink)] inline-flex items-center gap-1.5 truncate">
                <Pulse size={12} weight="duotone" />
                {ev.endpoint}
              </div>
              <Link
                href="/api-keys"
                className="mono text-[11.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:underline text-right"
              >
                {ev.keyId}
              </Link>
              <div className="text-right mono text-[11.5px] tabular-nums text-[var(--color-ink-3)]">
                {ev.latencyMs == null ? "—" : `${ev.latencyMs.toFixed(1)} ms`}
              </div>
              <div className="text-right mono text-[11.5px] tabular-nums text-[var(--color-ink-3)]">
                {ev.bytes == null ? "—" : fmtBytes(ev.bytes)}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
