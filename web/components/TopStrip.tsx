"use client";
import useSWR from "swr";

const fetcher = (u: string) => fetch(u).then(r => r.json());

interface Health {
  queued: number;
  running: number;
  passing: number;
  failing: number;
  totalPairs: number;
  totalRuns: number;
  serve: { status: string; model?: string };
}

export function TopStrip() {
  const { data } = useSWR<Health>("/api/health", fetcher, { refreshInterval: 8000 });
  const h = data ?? { queued: 0, running: 0, passing: 0, failing: 0, totalPairs: 0, totalRuns: 0, serve: { status: "unknown" } };
  const serveOk = h.serve?.status === "ok";

  const Item = ({ label, value, tone }: { label: string; value: string | number; tone?: "ok" | "warn" | "bad" | "muted" }) => (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-[var(--color-ink-4)] uppercase tracking-[0.14em] text-[10px]">{label}</span>
      <span
        className={
          "mono tnum text-[11.5px] " +
          (tone === "ok" ? "text-[var(--color-pos)]" :
           tone === "warn" ? "text-[var(--color-warn)]" :
           tone === "bad" ? "text-[var(--color-neg)]" :
           "text-[var(--color-ink)]")
        }
      >{value}</span>
    </span>
  );

  return (
    <div className="border-b border-[var(--color-rule)] bg-[var(--color-paper-2)]">
      <div className="mx-auto max-w-[1280px] px-7 h-8 flex items-center gap-5 text-[11px]">
        <span className="inline-flex items-center gap-1.5">
          <span className={`dot ${serveOk ? "bg-[var(--color-pos)]" : "bg-[var(--color-ink-4)]"}`} />
          <span className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
            serve {serveOk ? "online" : "offline"}
          </span>
        </span>
        <span className="text-[var(--color-rule-strong)]">·</span>
        <Item label="queued"  value={h.queued}  tone="muted" />
        <Item label="running" value={h.running} tone={h.running > 0 ? "warn" : "muted"} />
        <Item label="passing" value={h.passing} tone={h.passing > 0 ? "ok" : "muted"} />
        <Item label="failing" value={h.failing} tone={h.failing > 0 ? "bad" : "muted"} />
        <span className="text-[var(--color-rule-strong)]">·</span>
        <Item label="pairs" value={h.totalPairs.toLocaleString()} />
        <Item label="runs"  value={h.totalRuns} />
        <span className="ml-auto mono text-[10.5px] text-[var(--color-ink-4)]">
          {h.serve?.model ? `model ${h.serve.model}` : ""}
        </span>
      </div>
    </div>
  );
}
