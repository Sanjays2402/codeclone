import Link from "next/link";
import { loadRuns } from "../../lib/data";
import { H1 } from "../../components/Headings";
import { Empty } from "../../components/States";
import { fmtFloat, fmtTs, shortHash } from "../../lib/format";

export const dynamic = "force-dynamic";

const statusStyles: Record<string, string> = {
  queued:  "text-[var(--color-ink-4)]",
  running: "text-[var(--color-warn)]",
  passed:  "text-[var(--color-pos)]",
  failed:  "text-[var(--color-neg)]",
};
const statusGlyph: Record<string, string> = {
  queued: "○", running: "◐", passed: "●", failed: "×",
};

export default async function Page() {
  const runs = await loadRuns();
  return (
    <div>
      <H1 eyebrow={`eval · ${runs.length} runs`}>Training runs and adapter evals.</H1>
      {runs.length === 0 ? (
        <Empty title="No runs registered." hint="Train an adapter to populate runs/." mono="codeclone train --recipe recipes/default.yaml" />
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
    </div>
  );
}
