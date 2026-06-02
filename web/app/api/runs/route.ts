import { NextResponse } from "next/server";
import { loadRuns } from "../../../lib/data";

export const dynamic = "force-dynamic";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const ALLOWED_STATUS = new Set(["queued", "running", "passed", "failed"]);

export async function GET(req: Request) {
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

  const statusFilter = url.searchParams.get("status") ?? undefined;
  const backendFilter = url.searchParams.get("backend") ?? undefined;
  const modelFilter = url.searchParams.get("model") ?? undefined;

  let runs = await loadRuns();
  if (statusFilter && ALLOWED_STATUS.has(statusFilter)) {
    runs = runs.filter((r) => r.status === statusFilter);
  }
  if (backendFilter) {
    runs = runs.filter((r) => r.backend === backendFilter);
  }
  if (modelFilter) {
    runs = runs.filter((r) => r.model === modelFilter);
  }

  if (format === "csv") {
    // Export the full filtered slice so a researcher who narrowed to
    // status=passed or a specific backend gets that exact slice in
    // their spreadsheet, not just whatever the dashboard happened to
    // render on screen.
    const header = [
      "id",
      "recipe_hash",
      "steps",
      "last_loss",
      "backend",
      "model",
      "status",
      "started_at",
      "started_at_iso",
    ];
    const lines: string[] = [header.join(",")];
    for (const r of runs) {
      const iso =
        typeof r.startedAt === "number" && Number.isFinite(r.startedAt)
          ? new Date(r.startedAt).toISOString()
          : "";
      lines.push(
        [
          csvCell(r.id),
          csvCell(r.recipeHash),
          csvCell(r.steps),
          csvCell(r.lastLoss),
          csvCell(r.backend),
          csvCell(r.model),
          csvCell(r.status),
          csvCell(r.startedAt),
          csvCell(iso),
        ].join(","),
      );
    }
    const csv = lines.join("\r\n") + "\r\n";
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-runs.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return NextResponse.json({ items: runs, total: runs.length });
}
