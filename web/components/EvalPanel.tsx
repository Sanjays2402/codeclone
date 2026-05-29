import type { EvalReport } from "../lib/data";

export function EvalPanel({ reports }: { reports: EvalReport[] }) {
  if (reports.length === 0) {
    return <p className="subtle">No eval reports yet. Run `codeclone eval ...`.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Model</th>
          <th className="num">Perplexity</th>
          <th>Proxy?</th>
          <th className="num">Mini pass</th>
          <th className="num">Problems</th>
        </tr>
      </thead>
      <tbody>
        {reports.map((r, i) => (
          <tr key={`${r.model}-${i}`}>
            <td>{r.model}</td>
            <td className="num">{r.perplexity?.perplexity?.toFixed(3) ?? "—"}</td>
            <td className="subtle">{r.perplexity?.proxy ? "yes" : "no"}</td>
            <td className="num">{(r.mini_pass_rate * 100).toFixed(0)}%</td>
            <td className="num">{r.mini_scores?.length ?? 0}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
