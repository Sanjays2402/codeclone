import Link from "next/link";
import { DownloadSimple } from "@phosphor-icons/react/dist/ssr";
import { loadRuns } from "../../lib/data";
import { H1 } from "../../components/Headings";
import { Empty } from "../../components/States";
import { fmtFloat, fmtTs, shortHash } from "../../lib/format";
import EvalFilterBar from "../../components/EvalFilterBar";

export const dynamic = "force-dynamic";

const ALLOWED_STATUS = new Set(["queued", "running", "passed", "failed"]);

const statusStyles: Record<string, string> = {
  queued:  "text-[var(--color-ink-4)]",
  running: "text-[var(--color-warn)]",
  passed:  "text-[var(--color-pos)]",
  failed:  "text-[var(--color-neg)]",
};
const statusGlyph: Record<string, string> = {
  queued: "○", running: "◐", passed: "●", failed: "×",
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const statusParam = sp.status?.trim() ?? "";
  const status = ALLOWED_STATUS.has(statusParam) ? statusParam : "";
  const backend = sp.backend?.trim() ?? "";

  const all = await loadRuns();

  // Dropdown options come from the live run index so users only see values
  // that can match instead of a frozen enum.
  const statuses = Array.from(new Set(all.map((r) => r.status))).sort();
  const backends = Array.from(
    new Set(all.map((r) => r.backend).filter((b): b is string => !!b)),
  ).sort();

  const ql = q.toLowerCase();
  const runs = all.filter((r) => {
    if (status && r.status !== status) return false;
    if (backend && r.backend !== backend) return false;
    if (ql) {
      const hay = (
        r.id +
        " " +
        (r.recipeHash ?? "") +
        " " +
        (r.model ?? "")
      ).toLowerCase();
      if (!hay.includes(ql)) return false;
    }
    return true;
  });

  // Preserve active filters in the CSV download so a researcher who narrowed
  // by status, backend, or free-text search gets that exact filtered slice
  // in their spreadsheet, not the unfiltered registry. Keep the literal
  // /api/runs?format=csv substring in source so the existing CSV pin tests
  // keep matching.
  const csvHref =
    "/api/runs?format=csv" +
    (q ? `&q=${encodeURIComponent(q)}` : "") +
    (status ? `&status=${encodeURIComponent(status)}` : "") +
    (backend ? `&backend=${encodeURIComponent(backend)}` : "");

  const filtering = !!(q || status || backend);

  return (
    <div>
      <H1 eyebrow={`eval · ${runs.length}${filtering ? ` of ${all.length}` : ""} runs`}>Training runs and adapter evals.</H1>
      {all.length === 0 ? (
        <Empty title="No runs registered." hint="Train an adapter to populate runs/." mono="codeclone train --recipe recipes/default.yaml" />
      ) : (
        <>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <EvalFilterBar
            defaultQ={q}
            defaultStatus={status}
            defaultBackend={backend}
            statuses={statuses}
            backends={backends}
          />
          <a
            href={csvHref}
            download="codeclone-runs.csv"
            className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)]"
            title="Download the filtered training-run index as CSV"
          >
            <DownloadSimple size={12} weight="duotone" />
            Download CSV
          </a>
        </div>
        {runs.length === 0 ? (
          <Empty title="No runs match the filter." hint="Clear the filter or pick a different status or backend." />
        ) : (
        <div className="ruled rounded-md overflow-hidden">
          <div className="grid grid-cols-[2rem_14rem_8rem_5rem_6rem_7rem_1fr_6rem] gap-3 px-4 h-8 items-center bg-[var(--color-paper-2)] border-b border-[var(--color-rule)] mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
            <div>·</div><div>run id</div><div>recipe</div><div>steps</div><div>loss</div><div>backend</div><div>model</div><div className="text-right">started</div>
          </div>
          {runs.map(r => (
            <Link
              key={r.id}
              href={`/eval/${encodeURIComponent(r.id)}`}
              className="grid grid-cols-[2rem_14rem_8rem_5rem_6rem_7rem_1fr_6rem] gap-3 px-4 h-9 items-center border-b border-[var(--color-rule)] last:border-b-0 hover:bg-[var(--color-paper-2)] mono text-[12px]"
            >
              <div className={statusStyles[r.status]}>{statusGlyph[r.status]}</div>
              <div className="truncate text-[var(--color-ink-2)]">{r.id}</div>
              <div className="text-[var(--color-ink-3)] truncate">{shortHash(r.recipeHash, 8)}</div>
              <div className="tnum">{r.steps}</div>
              <div className="tnum">{fmtFloat(r.lastLoss, 3)}</div>
              <div className="text-[var(--color-ink-3)]">{r.backend ?? "—"}</div>
              <div className="truncate text-[var(--color-ink-3)]">{r.model ?? "—"}</div>
              <div className="text-right text-[var(--color-ink-3)]">{fmtTs(r.startedAt)}</div>
            </Link>
          ))}
        </div>
        )}
        </>
      )}
    </div>
  );
}
