import { NextResponse } from "next/server";
import { loadRun } from "../../../../../lib/data";

export const dynamic = "force-dynamic";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const ALLOWED_RESULT = new Set(["pass", "fail"]);

export async function GET(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;
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

  const resultFilterRaw = url.searchParams.get("result");
  const resultFilter =
    resultFilterRaw && ALLOWED_RESULT.has(resultFilterRaw.toLowerCase())
      ? resultFilterRaw.toLowerCase()
      : null;

  const run = await loadRun(decodeURIComponent(runId));
  if (!run) {
    return NextResponse.json(
      {
        error: {
          type: "not_found",
          message: `run '${runId}' not found.`,
        },
      },
      { status: 404 },
    );
  }

  let cases = run.evalReport?.mini_scores ?? [];
  if (resultFilter === "pass") {
    cases = cases.filter((c) => c.passed);
  } else if (resultFilter === "fail") {
    cases = cases.filter((c) => !c.passed);
  }

  if (format === "csv") {
    // Export the filtered per-case slice so a researcher who narrowed
    // by result=fail in the URL gets exactly the failing cases in their
    // spreadsheet, not the full grid they then have to re-filter.
    const header = ["run_id", "case", "result", "passed", "note"];
    const lines: string[] = [header.join(",")];
    for (const c of cases) {
      lines.push(
        [
          csvCell(run.id),
          csvCell(c.name),
          csvCell(c.passed ? "pass" : "fail"),
          csvCell(c.passed ? "true" : "false"),
          csvCell(c.error ?? ""),
        ].join(","),
      );
    }
    const csv = lines.join("\r\n") + "\r\n";
    const safeId = run.id.replace(/[^A-Za-z0-9._-]+/g, "_");
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-run-${safeId}-cases.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return NextResponse.json({
    run_id: run.id,
    items: cases,
    total: cases.length,
  });
}
