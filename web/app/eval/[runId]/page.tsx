import Link from "next/link";
import { notFound } from "next/navigation";
import { loadRun } from "../../../lib/data";
import { H1 } from "../../../components/Headings";
import { MetricChip } from "../../../components/MetricChip";
import { LossChart } from "../../../components/LossChart";
import { EvalGrid, EvalTable } from "../../../components/EvalGrid";
import { fmtFloat, fmtInt, fmtPct, fmtTs, shortHash } from "../../../lib/format";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = await loadRun(decodeURIComponent(runId));
  if (!run) notFound();
  const ev = run.evalReport;

  return (
    <div>
      <H1 eyebrow={`run · ${run.status}`}>
        <span className="mono">{run.id}</span>
      </H1>

      <div className="grid grid-cols-4 gap-3 mb-6">
        <MetricChip label="pass@1" value={ev ? fmtPct(ev.pass_at_1 ?? ev.mini_pass_rate, 1) : "—"} sub={ev?.model ?? "no eval"} accent large />
        <MetricChip label="exact-match" value={ev ? fmtPct(ev.exact_match ?? 0, 1) : "—"} sub={ev?.mini_scores ? `${ev.mini_scores.filter(c => c.passed).length} / ${ev.mini_scores.length}` : ""} />
        <MetricChip label="perplexity" value={ev?.perplexity ? fmtFloat(ev.perplexity.perplexity, 2) : "—"} sub={ev?.perplexity?.proxy ? "proxy" : ev?.perplexity ? "exact" : "—"} />
        <MetricChip label="last loss" value={fmtFloat(run.lastLoss, 3)} sub={`${fmtInt(run.steps)} steps`} />
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="ruled rounded-md p-4">
          <div className="eyebrow mb-1">recipe hash</div>
          <div className="mono text-[13px] text-[var(--color-ink)]">{shortHash(run.recipeHash, 16)}</div>
        </div>
        <div className="ruled rounded-md p-4">
          <div className="eyebrow mb-1">backend</div>
          <div className="mono text-[13px] text-[var(--color-ink)]">{run.backend ?? "—"}</div>
        </div>
        <div className="ruled rounded-md p-4">
          <div className="eyebrow mb-1">started</div>
          <div className="mono text-[13px] text-[var(--color-ink)]">{fmtTs(run.startedAt)}</div>
        </div>
      </div>

      <div className="ruled rounded-md p-4 mb-6">
        <div className="mb-2 flex items-baseline justify-between">
          <div>
            <div className="eyebrow mb-1">loss · per step</div>
            <h2 className="text-[15px] tracking-tight font-medium">Training curve</h2>
          </div>
          <div className="mono text-[11px] text-[var(--color-ink-3)]">{run.metrics.length} points</div>
        </div>
        <LossChart data={run.metrics.map(m => ({ step: m.step, loss: m.loss }))} />
      </div>

      <div className="mt-10 mb-3">
        <div className="eyebrow mb-1">eval · per-case heatmap</div>
        <h2 className="text-[17px] tracking-tight font-medium">Case grid</h2>
      </div>
      <EvalGrid cases={ev?.mini_scores ?? []} />

      <div className="mt-10 mb-3">
        <div className="eyebrow mb-1">eval · table</div>
        <h2 className="text-[17px] tracking-tight font-medium">Case detail</h2>
      </div>
      <EvalTable cases={ev?.mini_scores ?? []} />

      <div className="mt-10 mb-3">
        <div className="eyebrow mb-1">params · raw</div>
        <h2 className="text-[17px] tracking-tight font-medium">Run params</h2>
      </div>
      <pre className="ruled rounded-md p-4 mono text-[11.5px] overflow-auto max-h-[360px]">
        {run.params ? JSON.stringify(run.params, null, 2) : "no params.json"}
      </pre>

      <div className="mt-8">
        <Link href="/eval" className="mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">← back to runs</Link>
      </div>
    </div>
  );
}
