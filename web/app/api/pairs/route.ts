import { NextResponse } from "next/server";
import { loadPairsList } from "../../../lib/data";

export const dynamic = "force-dynamic";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

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
  const q = url.searchParams.get("q") ?? undefined;
  const lang = url.searchParams.get("lang") ?? undefined;

  if (format === "csv") {
    // Export every row that matches the filters, not just the on-screen page,
    // so a researcher who filtered to "python" or a specific repo gets the
    // full filtered slice in their spreadsheet rather than the first 300.
    const { items } = await loadPairsList({ limit: Number.MAX_SAFE_INTEGER, offset: 0, q, lang });
    const header = [
      "id",
      "language",
      "repo",
      "path",
      "commit_sha",
      "similarity",
      "split",
      "kind",
      "n_prefix_chars",
      "n_completion_chars",
      "ts",
    ];
    const lines: string[] = [header.join(",")];
    for (const p of items) {
      lines.push(
        [
          csvCell(p.id),
          csvCell(p.language),
          csvCell(p.repo),
          csvCell(p.path),
          csvCell(p.commit_sha),
          csvCell(p.similarity.toFixed(4)),
          csvCell(p.split),
          csvCell(p.kind),
          csvCell(p.n_prefix_chars),
          csvCell(p.n_completion_chars),
          csvCell(new Date(p.ts).toISOString()),
        ].join(","),
      );
    }
    const csv = lines.join("\r\n") + "\r\n";
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-pairs.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const limit = Number(url.searchParams.get("limit") ?? 100);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const data = await loadPairsList({ limit, offset, q, lang });
  return NextResponse.json(data);
}
