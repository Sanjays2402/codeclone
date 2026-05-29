import { TopBar } from "../components/TopBar";
import { MetricCard } from "../components/MetricCard";
import { ServeHealth } from "../components/ServeHealth";
import { RunsTable } from "../components/RunsTable";
import { EvalPanel } from "../components/EvalPanel";
import {
  loadDatasetStats,
  loadLatestRun,
  loadRuns,
  loadEvalReports,
  loadAdapters
} from "../lib/data";

export const dynamic = "force-dynamic";

export default async function Page() {
  const datasetStats = await loadDatasetStats();
  const latestRun = await loadLatestRun();
  const runs = await loadRuns();
  const evalReports = await loadEvalReports();
  const adapters = await loadAdapters();

  const trainPairs = datasetStats?.train?.total ?? 0;
  const valPairs = datasetStats?.val?.total ?? 0;
  const testPairs = datasetStats?.test?.total ?? 0;
  const totalPairs = trainPairs + valPairs + testPairs;

  const lastLoss = latestRun?.lastLoss ?? null;
  const lastSteps = latestRun?.steps ?? 0;
  const lastRecipeHash = latestRun?.recipeHash ?? "-";

  const passRate = evalReports[0]?.mini_pass_rate ?? 0;
  const ppl = evalReports[0]?.perplexity?.perplexity ?? null;

  return (
    <main className="container">
      <TopBar />

      <div className="grid grid-4">
        <MetricCard
          title="Dataset pairs"
          value={totalPairs.toLocaleString()}
          sub={`${trainPairs.toLocaleString()} train · ${valPairs.toLocaleString()} val · ${testPairs.toLocaleString()} test`}
        />
        <MetricCard
          title="Latest train loss"
          value={lastLoss !== null ? lastLoss.toFixed(3) : "—"}
          sub={`${lastSteps} steps · ${lastRecipeHash}`}
        />
        <MetricCard
          title="Mini-eval pass rate"
          value={evalReports.length ? `${(passRate * 100).toFixed(0)}%` : "—"}
          sub={ppl !== null ? `ppl ${ppl.toFixed(2)}` : "no perplexity yet"}
        />
        <ServeHealth />
      </div>

      <h2 className="section-title">Training runs</h2>
      <div className="card">
        <RunsTable runs={runs} />
      </div>

      <h2 className="section-title">Recent evaluations</h2>
      <div className="card">
        <EvalPanel reports={evalReports} />
      </div>

      <h2 className="section-title">Adapters</h2>
      <div className="card">
        {adapters.length === 0 ? (
          <p className="subtle">No adapters registered yet. Run `codeclone train ...`.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Base</th>
                <th>Backend</th>
                <th>Recipe hash</th>
                <th>Created</th>
                <th>Loss</th>
              </tr>
            </thead>
            <tbody>
              {adapters.map((a) => (
                <tr key={a.name}>
                  <td>{a.name}</td>
                  <td className="subtle">{a.base_model}</td>
                  <td>{a.backend}</td>
                  <td className="num subtle">{a.recipe_hash}</td>
                  <td className="subtle">{a.created_at}</td>
                  <td className="num">{a.final_train_loss?.toFixed(3) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer>
        CodeClone dashboard · reads from {process.env.CODECLONE_RUNS_DIR} and{" "}
        {process.env.CODECLONE_SERVE_URL}
      </footer>
    </main>
  );
}
