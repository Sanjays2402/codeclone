"use client";

/**
 * Workspace owner view of active sign-in lockouts.
 *
 * Calls /api/security/lockouts which returns opaque hashes (never raw
 * emails or IPs) so the UI surface itself can never leak personal
 * data, even to a compromised owner account.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ShieldWarning,
  ArrowsClockwise,
  EnvelopeSimple,
  Globe,
  Clock,
  DownloadSimple,
} from "@phosphor-icons/react/dist/ssr";
import { H1, H2 } from "../../../../components/Headings";
import { Empty, ErrorBlock, LoadingRow } from "../../../../components/States";

interface ActiveLockout {
  scope: "email" | "ip";
  hash: string;
  count: number;
  windowStart: number;
  lockedUntil: number;
}

interface LockoutsResponse {
  config: {
    emailMax: number;
    ipMax: number;
    windowSec: number;
    lockoutSec: number;
  };
  lockouts: ActiveLockout[];
}

function fmtRel(ts: number): string {
  const delta = Math.max(0, ts - Date.now());
  if (delta <= 0) return "expired";
  const mins = Math.ceil(delta / 60000);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
}

function fmtAbs(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

export default function LockoutsPage() {
  const [data, setData] = useState<LockoutsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/security/lockouts", { cache: "no-store" });
      if (res.status === 401) {
        setError("Sign in to view security lockouts.");
        setData(null);
        return;
      }
      if (res.status === 403) {
        setError("Workspace owners only. Ask an owner to invite you with the owner role.");
        setData(null);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error?.message ?? `Request failed (${res.status}).`);
        setData(null);
        return;
      }
      setData((await res.json()) as LockoutsResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  const lockouts = data?.lockouts ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <H1>
            <ShieldWarning weight="duotone" className="inline size-7 align-text-bottom text-amber-600" />{" "}
            Sign-in lockouts
          </H1>
          <p className="mt-2 text-sm text-zinc-600">
            Active brute-force protections on the magic link endpoint. Identifiers
            are shown as opaque hashes so this view never leaks raw emails or
            client IPs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/api/security/lockouts?format=csv"
            download="codeclone-security-lockouts.csv"
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
            title="Download the active lockouts as CSV for an incident report"
          >
            <DownloadSimple weight="duotone" className="size-4" />
            Download CSV
          </a>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
          >
            <ArrowsClockwise weight="duotone" className="size-4" />
            Refresh
          </button>
        </div>
      </div>

      {data && (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Per email" value={`${data.config.emailMax}`} suffix="max" />
          <Stat label="Per IP" value={`${data.config.ipMax}`} suffix="max" />
          <Stat label="Window" value={`${Math.round(data.config.windowSec / 60)}`} suffix="min" />
          <Stat label="Lockout" value={`${Math.round(data.config.lockoutSec / 60)}`} suffix="min" />
        </div>
      )}

      <div className="mt-8">
        <H2>Active</H2>
        <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white">
          {error ? (
            <div className="p-4">
              <ErrorBlock message={error} />
            </div>
          ) : loading && !data ? (
            <div className="p-4">
              <LoadingRow />
              <LoadingRow />
            </div>
          ) : lockouts.length === 0 ? (
            <div className="p-6">
              <Empty
                title="No active lockouts"
                hint="Nothing is currently blocked. Failed sign-in bursts will appear here."
              />
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {lockouts.map((lo) => (
                <li
                  key={`${lo.scope}-${lo.hash}`}
                  className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    {lo.scope === "email" ? (
                      <EnvelopeSimple
                        weight="duotone"
                        className="size-5 shrink-0 text-zinc-500"
                      />
                    ) : (
                      <Globe weight="duotone" className="size-5 shrink-0 text-zinc-500" />
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                          {lo.scope}
                        </span>
                        <code className="truncate font-mono text-xs text-zinc-700">
                          {lo.hash.slice(0, 16)}
                        </code>
                      </div>
                      <div className="text-xs text-zinc-500">
                        {lo.count} attempts in window starting {fmtAbs(lo.windowStart)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-zinc-600 sm:text-right">
                    <Clock weight="duotone" className="size-4 text-amber-600" />
                    <span>
                      Clears in <strong className="font-semibold">{fmtRel(lo.lockedUntil)}</strong>
                    </span>
                    <span className="hidden text-zinc-400 sm:inline">{fmtAbs(lo.lockedUntil)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, suffix }: { label: string; value: string; suffix: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3">
      <div className="text-xs font-medium text-zinc-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-xl font-semibold text-zinc-900">{value}</span>
        <span className="text-xs text-zinc-500">{suffix}</span>
      </div>
    </div>
  );
}
