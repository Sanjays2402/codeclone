"use client";

import useSWR from "swr";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function ServeHealth() {
  const { data } = useSWR("/api/serve-health", fetcher, { refreshInterval: 5000 });
  const status = data?.status ?? "loading";
  const model = data?.model ?? "—";
  const base = data?.base ?? "";
  const cls = status === "ok" ? "ok" : status === "loading" ? "idle" : "bad";

  return (
    <div className="card">
      <h3>Serve health</h3>
      <div className="metric">
        <span className={`dot ${cls}`} />
        {status === "ok" ? "up" : status === "loading" ? "…" : "down"}
      </div>
      <div className="metric-sub">
        {model} <span className="faint">· {base.replace(/^https?:\/\//, "")}</span>
      </div>
    </div>
  );
}
