"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck,
  DesktopTower,
  SignOut,
  ArrowsClockwise,
  Warning,
  Clock,
  Trash,
} from "@phosphor-icons/react/dist/ssr";
import { H1, H2 } from "../../../components/Headings";
import { ErrorBlock, LoadingRow, Empty } from "../../../components/States";

interface SessionItem {
  jti: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
  createdIp: string | null;
  createdUserAgent: string | null;
  current: boolean;
}

interface Payload {
  sessions: SessionItem[];
  currentJti: string | null;
  ttl: { current: number; min: number; max: number };
}

const TTL_PRESETS: { label: string; sec: number }[] = [
  { label: "1 hour", sec: 60 * 60 },
  { label: "8 hours", sec: 8 * 60 * 60 },
  { label: "1 day", sec: 24 * 60 * 60 },
  { label: "7 days", sec: 7 * 24 * 60 * 60 },
  { label: "30 days", sec: 30 * 24 * 60 * 60 },
  { label: "90 days", sec: 90 * 24 * 60 * 60 },
];

function fmtAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

function parseUA(ua: string | null): string {
  if (!ua) return "Unknown client";
  // Light heuristic. Keep it short and honest.
  let browser = "Browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua)) browser = "Safari";
  else if (/curl\//.test(ua)) browser = "curl";
  let os = "";
  if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Windows NT/.test(ua)) os = "Windows";
  else if (/Android/.test(ua)) os = "Android";
  else if (/iPhone|iPad/.test(ua)) os = "iOS";
  else if (/Linux/.test(ua)) os = "Linux";
  return os ? `${browser} on ${os}` : browser;
}

export default function SessionsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [ttlBusy, setTtlBusy] = useState(false);
  const [ttlMsg, setTtlMsg] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions", { cache: "no-store" });
      if (res.status === 401) {
        window.location.href = "/signin?redirect=/settings/sessions";
        return;
      }
      if (!res.ok) throw new Error(`Request failed (${res.status}).`);
      setData((await res.json()) as Payload);
      setStatus("ready");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const revokeOne = useCallback(
    async (jti: string) => {
      setBusy(jti);
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(jti)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(`Revoke failed (${res.status}).`);
        await refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const revokeOthers = useCallback(async () => {
    if (!confirm("Sign out of every other session? You will stay signed in here.")) return;
    setBusy("others");
    try {
      const res = await fetch("/api/sessions/revoke-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeCurrent: false }),
      });
      if (!res.ok) throw new Error(`Revoke failed (${res.status}).`);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const revokeEverywhere = useCallback(async () => {
    if (!confirm("Sign out everywhere, including this device?")) return;
    setBusy("all");
    try {
      const res = await fetch("/api/sessions/revoke-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeCurrent: true }),
      });
      if (!res.ok) throw new Error(`Revoke failed (${res.status}).`);
      window.location.href = "/signin?redirect=/settings/sessions";
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }, []);

  const saveTtl = useCallback(
    async (sec: number) => {
      setTtlBusy(true);
      setTtlMsg("");
      try {
        const res = await fetch("/api/sessions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ttlSec: sec }),
        });
        if (!res.ok) throw new Error(`Update failed (${res.status}).`);
        setTtlMsg("Saved. New sign-ins will use this lifetime.");
        await refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setTtlBusy(false);
      }
    },
    [refresh],
  );

  return (
    <main className="mx-auto max-w-3xl px-5 py-10 sm:py-14">
      <H1 eyebrow="Settings">
        <span className="inline-flex items-center gap-3">
          <ShieldCheck weight="duotone" className="text-[var(--color-ink-2)]" size={28} />
          Active sessions
        </span>
      </H1>
      <p className="text-[14px] text-[var(--color-ink-2)] mb-2 max-w-prose">
        Every browser or device that has signed in to your account. Revoke any
        that you do not recognize. Revoking a session ends its cookie immediately
        on the next request.
      </p>

      {status === "loading" && <LoadingRow rows={4} />}
      {status === "error" && <ErrorBlock message={err || "Failed to load sessions."} />}

      {status === "ready" && data && (
        <>
          <H2 eyebrow="Devices" right={
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-3)] hover:text-[var(--color-ink-1)]"
            >
              <ArrowsClockwise weight="duotone" size={14} /> Refresh
            </button>
          }>
            Signed-in devices
          </H2>

          {data.sessions.length === 0 ? (
            <Empty
              title="No tracked sessions yet."
              hint="Sessions appear here after you sign in. Older cookies issued before this feature shipped expire on their own."
            />
          ) : (
            <ul className="ruled rounded-md overflow-hidden">
              {data.sessions.map((s) => (
                <li
                  key={s.jti}
                  className="border-b border-[var(--color-rule)] last:border-b-0 px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <DesktopTower weight="duotone" size={18} className="text-[var(--color-ink-2)] shrink-0" />
                      <span className="text-[14px] font-medium truncate">
                        {parseUA(s.userAgent)}
                      </span>
                      {s.current && (
                        <span className="mono text-[10px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded bg-[var(--color-pos-soft)] text-[var(--color-pos)]">
                          this device
                        </span>
                      )}
                    </div>
                    <div className="text-[12.5px] text-[var(--color-ink-3)] flex flex-wrap gap-x-4 gap-y-1">
                      <span title={s.ip ?? ""}>IP {s.ip ?? "unknown"}</span>
                      <span title={fmtDate(s.lastSeenAt)}>Last seen {fmtAgo(s.lastSeenAt)}</span>
                      <span title={fmtDate(s.createdAt)}>Signed in {fmtAgo(s.createdAt)}</span>
                      <span title={fmtDate(s.expiresAt)}>Expires {fmtAgo(s.expiresAt).replace(" ago", "")}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void revokeOne(s.jti)}
                    disabled={busy === s.jti}
                    className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] disabled:opacity-50"
                  >
                    <Trash weight="duotone" size={14} />
                    {busy === s.jti ? "Revoking" : s.current ? "Sign out" : "Revoke"}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void revokeOthers()}
              disabled={busy !== null || data.sessions.filter((s) => !s.current).length === 0}
              className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-3 py-2 rounded border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] disabled:opacity-40"
            >
              <SignOut weight="duotone" size={14} /> Sign out other devices
            </button>
            <button
              type="button"
              onClick={() => void revokeEverywhere()}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-3 py-2 rounded border border-[color:var(--color-neg-bar)] text-[var(--color-neg)] hover:bg-[var(--color-neg-soft)] disabled:opacity-40"
            >
              <Warning weight="duotone" size={14} /> Sign out everywhere
            </button>
          </div>

          <H2 eyebrow="Policy">
            <span className="inline-flex items-center gap-2">
              <Clock weight="duotone" size={20} className="text-[var(--color-ink-2)]" />
              Session lifetime
            </span>
          </H2>
          <p className="text-[13.5px] text-[var(--color-ink-2)] mb-3 max-w-prose">
            Controls how long a new sign-in stays valid before the user has to
            reauthenticate. Existing sessions keep their current lifetime.
          </p>
          <div className="flex flex-wrap gap-2">
            {TTL_PRESETS.map((p) => {
              const active = data.ttl.current === p.sec;
              return (
                <button
                  key={p.sec}
                  type="button"
                  onClick={() => void saveTtl(p.sec)}
                  disabled={ttlBusy || active}
                  className={[
                    "mono text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 rounded border",
                    active
                      ? "border-[var(--color-ink-1)] bg-[var(--color-paper-2)] text-[var(--color-ink-1)]"
                      : "border-[var(--color-rule)] text-[var(--color-ink-2)] hover:bg-[var(--color-paper-2)]",
                  ].join(" ")}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          {ttlMsg && (
            <div className="mt-3 text-[12.5px] text-[var(--color-pos)]">{ttlMsg}</div>
          )}
        </>
      )}
    </main>
  );
}
