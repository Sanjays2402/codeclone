import { DownloadSimple } from "@phosphor-icons/react/dist/ssr";
import { loadAdapters, loadEvalReports } from "../../lib/data";
import { H1 } from "../../components/Headings";
import { Empty } from "../../components/States";
import { fmtFloat, fmtPct, shortHash } from "../../lib/format";
import ModelsFilterBar from "../../components/ModelsFilterBar";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const backend = sp.backend?.trim() ?? "";
  // minPass narrows the registry to adapters that cleared a pass@1 (or
  // mini_pass_rate fallback) quality bar. Empty / invalid box is a no-op
  // so the unfiltered registry still renders by default and a fat-finger
  // doesn't blank the page.
  const minPassRaw = sp.minPass;
  let minPass: number | undefined = undefined;
  if (minPassRaw !== undefined && minPassRaw !== "") {
    const n = Number(minPassRaw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) minPass = n;
  }

  const [all, evals] = await Promise.all([loadAdapters(), loadEvalReports()]);
  // join eval by model name
  const byModel = new Map<string, typeof evals[number]>();
  for (const e of evals) byModel.set(e.model, e);

  // Backend dropdown options come from the actual registry so users only see
  // values that can match (mlx, peft, mock, etc.) and not a frozen enum.
  const backends = Array.from(new Set(all.map((a) => a.backend))).sort();

  const ql = q.toLowerCase();
  const adapters = all.filter((a) => {
    if (backend && a.backend !== backend) return false;
    if (ql) {
      const hay = a.name.toLowerCase() + " " + a.base_model.toLowerCase();
      if (!hay.includes(ql)) return false;
    }
    if (minPass !== undefined && minPass > 0) {
      const ev = byModel.get(a.name);
      if (!ev) return false;
      const score = ev.pass_at_1 ?? ev.mini_pass_rate;
      if (typeof score !== "number" || score < minPass) return false;
    }
    return true;
  });

  // Preserve active filters in the CSV download so a researcher who narrowed
  // by name or backend gets that exact filtered slice in their spreadsheet,
  // not the unfiltered registry.
  // CSV endpoint is /api/models?format=csv; we append the active filters
  // (q, backend) so the spreadsheet matches the on-screen slice.
  const csvParams = new URLSearchParams({ format: "csv" });
  if (q) csvParams.set("q", q);
  if (backend) csvParams.set("backend", backend);
  if (minPass !== undefined) csvParams.set("minPass", String(minPass));
  const csvHref = `/api/models?${csvParams.toString()}`;

  return (
    <div>
      <H1 eyebrow={`models · ${adapters.length} of ${all.length} registered`}>Adapter index.</H1>
      {all.length === 0 ? (
        <Empty title="No adapters registered." hint="Train an adapter to populate adapters/index.json." mono="codeclone train --recipe recipes/default.yaml" />
      ) : (
        <>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <ModelsFilterBar defaultQ={q} defaultBackend={backend} defaultMinPass={minPass} backends={backends} />
          <a
            href={csvHref}
            download="codeclone-models.csv"
            className="inline-flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm border border-[var(--color-rule)] hover:bg-[var(--color-paper-2)] text-[var(--color-ink-2)]"
            title="Download the filtered adapter index (joined with eval metrics) as CSV"
          >
            <DownloadSimple size={12} weight="duotone" />
            Download CSV
          </a>
        </div>
        {adapters.length === 0 ? (
          <Empty title="No adapters match the filter." hint="Clear the filter or pick a different backend." mono="" />
        ) : (
        <div className="ruled rounded-md overflow-hidden">
          <div className="grid grid-cols-[14rem_1fr_5rem_8rem_6rem_6rem_6rem] gap-3 px-4 h-8 items-center bg-[var(--color-paper-2)] border-b border-[var(--color-rule)] mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
            <div>name</div><div>base</div><div>backend</div><div>recipe</div><div>loss</div><div>pass@1</div><div className="text-right">created</div>
          </div>
          {adapters.map(a => {
            const ev = byModel.get(a.name);
            return (
              <div key={a.name} className="grid grid-cols-[14rem_1fr_5rem_8rem_6rem_6rem_6rem] gap-3 px-4 h-9 items-center border-b border-[var(--color-rule)] last:border-b-0 mono text-[12px]">
                <div className="truncate text-[var(--color-ink)]">{a.name}</div>
                <div className="truncate text-[var(--color-ink-3)]">{a.base_model}</div>
                <div className="text-[var(--color-ink-3)]">{a.backend}</div>
                <div className="text-[var(--color-ink-3)] truncate">{shortHash(a.recipe_hash, 10)}</div>
                <div className="tnum">{fmtFloat(a.final_train_loss, 3)}</div>
                <div className={"tnum " + (ev ? "text-[var(--color-accent-ink)]" : "text-[var(--color-ink-4)]")}>{ev ? fmtPct(ev.pass_at_1 ?? ev.mini_pass_rate, 0) : "—"}</div>
                <div className="text-right text-[var(--color-ink-3)] truncate">{a.created_at.slice(0, 10)}</div>
              </div>
            );
          })}
        </div>
        )}
        </>
      )}
    </div>
  );
}
