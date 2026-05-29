import type { RunSummary } from "../lib/data";

export function RunsTable({ runs }: { runs: RunSummary[] }) {
  if (runs.length === 0) {
    return <p className="subtle">No training runs yet. Run `codeclone train ...`.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Run</th>
          <th>Recipe hash</th>
          <th className="num">Steps</th>
          <th className="num">Final loss</th>
          <th>Backend</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id}>
            <td>{r.id}</td>
            <td className="num subtle">{r.recipeHash}</td>
            <td className="num">{r.steps}</td>
            <td className="num">{r.lastLoss !== null ? r.lastLoss.toFixed(3) : "—"}</td>
            <td className="subtle">{r.backend ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
