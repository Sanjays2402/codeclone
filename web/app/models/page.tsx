import { loadAdapters, loadEvalReports } from "../../lib/data";
import { H1 } from "../../components/Headings";
import { Empty } from "../../components/States";
import { fmtFloat, fmtPct, shortHash } from "../../lib/format";

export const dynamic = "force-dynamic";

export default async function Page() {
  const [adapters, evals] = await Promise.all([loadAdapters(), loadEvalReports()]);
  // join eval by model name
  const byModel = new Map<string, typeof evals[number]>();
  for (const e of evals) byModel.set(e.model, e);

  return (
    <div>
      <H1 eyebrow={`models · ${adapters.length} registered`}>Adapter index.</H1>
      {adapters.length === 0 ? (
        <Empty title="No adapters registered." hint="Train an adapter to populate adapters/index.json." mono="codeclone train --recipe recipes/default.yaml" />
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
    </div>
  );
}
