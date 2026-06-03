/**
 * JSON snapshot of in-process metrics for the /status UI. Same numbers as
 * /api/metrics but in a shape that's friendly to render.
 *
 * Also supports `?format=csv` so an on-call engineer can snapshot the
 * per-route latency table into a spreadsheet during a postmortem
 * instead of copy-pasting numbers out of the rendered grid.
 */
import { NextResponse } from "next/server";
import { instrument } from "../../../../lib/instrument";
import { snapshot } from "../../../../lib/observability";

export const dynamic = "force-dynamic";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export const GET = instrument("/api/observability/snapshot", async (req: Request) => {
  const url = new URL(req.url);
  const formatRaw = url.searchParams.get("format");
  const format =
    formatRaw === null || formatRaw === "" ? "json" : formatRaw.toLowerCase();
  if (format !== "json" && format !== "csv") {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "format must be 'json' (default) or 'csv'.",
        },
      },
      { status: 400 },
    );
  }

  const snap = snapshot();

  if (format === "csv") {
    // Per-route latency is what an on-call engineer actually wants in a
    // postmortem: which route, how often, average and tail latency,
    // and the matching status-code mix so a p95 spike can be paired
    // with the 5xx count from the same window.
    const header = ["method", "route", "count", "avg_ms", "p50_ms", "p95_ms", "status_counts"];
    const lines: string[] = [header.join(",")];

    const statusByRoute = new Map<string, Map<string, number>>();
    for (const r of snap.byRoute) {
      const key = `${r.method}|${r.route}`;
      let inner = statusByRoute.get(key);
      if (!inner) {
        inner = new Map();
        statusByRoute.set(key, inner);
      }
      inner.set(r.status, (inner.get(r.status) ?? 0) + r.count);
    }

    for (const row of snap.latency) {
      const key = `${row.method}|${row.route}`;
      const inner = statusByRoute.get(key);
      const statusMix = inner
        ? Array.from(inner.entries())
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
            .map(([s, n]) => `${s}:${n}`)
            .join(" ")
        : "";
      lines.push(
        [
          csvCell(row.method),
          csvCell(row.route),
          csvCell(row.count),
          csvCell(row.avgMs),
          csvCell(row.p50Ms),
          csvCell(row.p95Ms),
          csvCell(statusMix),
        ].join(","),
      );
    }
    const csv = lines.join("\r\n") + "\r\n";
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-status.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return NextResponse.json(snap, { headers: { "cache-control": "no-store" } });
});
