import { NextResponse } from "next/server";
import { loadDatasetStats } from "../../../lib/data";

export const dynamic = "force-dynamic";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const ALLOWED_SPLITS = new Set(["train", "val", "test", "all"]);

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

  const splitRaw = url.searchParams.get("split");
  const split = splitRaw ? splitRaw.toLowerCase() : "all";
  if (!ALLOWED_SPLITS.has(split)) {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "split must be one of 'train', 'val', 'test', or 'all'.",
        },
      },
      { status: 400 },
    );
  }

  const stats = await loadDatasetStats();
  if (!stats) {
    if (format === "csv") {
      const csv = ["split,language,pairs,share\r\n"].join("");
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="codeclone-datasets.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json({ stats: null, items: [], total: 0 });
  }

  // Optional case-insensitive substring filter on the language name so the
  // CSV download matches the filtered slice the /datasets page is showing.
  const qRaw = url.searchParams.get("q");
  const qFilter = (qRaw ?? "").trim().toLowerCase();

  const splits: Array<["train" | "val" | "test", number, Record<string, number>]> = [];
  for (const name of ["train", "val", "test"] as const) {
    if (split !== "all" && split !== name) continue;
    const s = stats[name];
    if (!s) continue;
    const byLang = s.by_language ?? {};
    const filtered = qFilter
      ? Object.fromEntries(Object.entries(byLang).filter(([lang]) => lang.toLowerCase().includes(qFilter)))
      : byLang;
    splits.push([name, s.total ?? 0, filtered]);
  }

  if (format === "csv") {
    // Export the per-language pair counts a researcher actually wants
    // in a spreadsheet: which split, which language, how many pairs,
    // and the language's share of that split (so you can sort by
    // dominance without recomputing it in Excel).
    const header = ["split", "language", "pairs", "share"];
    const lines: string[] = [header.join(",")];
    for (const [name, total, byLang] of splits) {
      const entries = Object.entries(byLang).sort((a, b) => b[1] - a[1]);
      for (const [lang, n] of entries) {
        const share = total > 0 ? n / total : 0;
        lines.push(
          [
            csvCell(name),
            csvCell(lang),
            csvCell(n),
            csvCell(share.toFixed(6)),
          ].join(","),
        );
      }
    }
    const csv = lines.join("\r\n") + "\r\n";
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-datasets.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const items: Array<{
    split: string;
    language: string;
    pairs: number;
    share: number;
  }> = [];
  for (const [name, total, byLang] of splits) {
    for (const [lang, n] of Object.entries(byLang).sort((a, b) => b[1] - a[1])) {
      items.push({
        split: name,
        language: lang,
        pairs: n,
        share: total > 0 ? n / total : 0,
      });
    }
  }
  return NextResponse.json({ stats, items, total: items.length });
}
