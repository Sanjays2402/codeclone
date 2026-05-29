interface Props {
  title: string;
  value: string;
  sub?: string;
}

export function MetricCard({ title, value, sub }: Props) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="metric">{value}</div>
      {sub ? <div className="metric-sub">{sub}</div> : null}
    </div>
  );
}
