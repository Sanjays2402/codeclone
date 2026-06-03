import { NextResponse } from "next/server";
import { loadAdapters, loadEvalReports } from "../../../lib/data";

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

  const backendFilter = url.searchParams.get("backend") ?? undefined;
  const baseFilter = url.searchParams.get("base") ?? undefined;
  // Free-text filter matches adapter name or base model substring (case
  // insensitive). Mirrors the q box on the /models page so the CSV export
  // and the on-screen table stay in sync when a researcher narrows the view.
  const qFilter = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  // Minimum pass@1 threshold (0..1). Lets a researcher narrow the registry
  // to adapters that cleared a quality bar (e.g. minPass=0.5) without
  // hand-grepping eval reports. Falls back to mini_pass_rate when an
  // adapter has no pass_at_1 row, matching the on-screen join. Empty box
  // is a no-op so the unfiltered registry still ships by default.
  const minPassRaw = url.searchParams.get("minPass");
  let minPass: number | undefined = undefined;
  if (minPassRaw !== null && minPassRaw !== "") {
    const n = Number(minPassRaw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return NextResponse.json(
        {
          error: {
            type: "invalid_request",
            message: "minPass must be a number between 0 and 1.",
          },
        },
        { status: 400 },
      );
    }
    minPass = n;
  }

  let adapters = await loadAdapters();
  if (backendFilter) {
    adapters = adapters.filter((a) => a.backend === backendFilter);
  }
  if (baseFilter) {
    adapters = adapters.filter((a) => a.base_model === baseFilter);
  }
  if (qFilter) {
    adapters = adapters.filter(
      (a) =>
        a.name.toLowerCase().includes(qFilter) ||
        a.base_model.toLowerCase().includes(qFilter),
    );
  }

  // Eval reports are loaded once and reused for both the minPass filter and
  // the CSV join below, so we never read the registry twice per request.
  const evals = await loadEvalReports();
  const byModel = new Map<string, (typeof evals)[number]>();
  for (const e of evals) byModel.set(e.model, e);

  if (minPass !== undefined && minPass > 0) {
    const threshold = minPass;
    adapters = adapters.filter((a) => {
      const ev = byModel.get(a.name);
      if (!ev) return false;
      const score = ev.pass_at_1 ?? ev.mini_pass_rate;
      return typeof score === "number" && score >= threshold;
    });
  }

  if (format === "csv") {
    // CSV row carries the headline pass@1 / mini_pass_rate next to the
    // adapter, matching what the /models page joins on screen. An adapter
    // with no eval row gets blank metric cells rather than a missing column.
    const header = [
      "name",
      "base_model",
      "backend",
      "recipe_hash",
      "final_train_loss",
      "pass_at_1",
      "mini_pass_rate",
      "created_at",
    ];
    const lines: string[] = [header.join(",")];
    for (const a of adapters) {
      const ev = byModel.get(a.name);
      lines.push(
        [
          csvCell(a.name),
          csvCell(a.base_model),
          csvCell(a.backend),
          csvCell(a.recipe_hash),
          csvCell(a.final_train_loss),
          csvCell(ev?.pass_at_1 ?? ""),
          csvCell(ev?.mini_pass_rate ?? ""),
          csvCell(a.created_at),
        ].join(","),
      );
    }
    const csv = lines.join("\r\n") + "\r\n";
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-models.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return NextResponse.json({ items: adapters });
}
