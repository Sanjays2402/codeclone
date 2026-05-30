"use client";
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

interface Point { step: number; loss?: number }

export function LossChart({ data }: { data: Point[] }) {
  const points = data.filter(d => typeof d.loss === "number");
  if (points.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center mono text-[11.5px] text-[var(--color-ink-4)]">
        no metric points
      </div>
    );
  }
  return (
    <div className="h-[220px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 10, right: 20, bottom: 8, left: 0 }}>
          <CartesianGrid stroke="var(--color-rule)" vertical={false} />
          <XAxis dataKey="step" stroke="var(--color-ink-4)" tick={{ fontSize: 10, fontFamily: "var(--font-jetbrains-mono)" }} tickLine={false} axisLine={false} />
          <YAxis stroke="var(--color-ink-4)" tick={{ fontSize: 10, fontFamily: "var(--font-jetbrains-mono)" }} tickLine={false} axisLine={false} width={42} />
          <Tooltip
            contentStyle={{
              background: "var(--color-paper)",
              border: "1px solid var(--color-rule-strong)",
              borderRadius: 4,
              fontFamily: "var(--font-jetbrains-mono)",
              fontSize: 11,
            }}
            labelFormatter={(v) => `step ${v}`}
            formatter={(v: number) => [v.toFixed(4), "loss"]}
          />
          <Line type="monotone" dataKey="loss" stroke="var(--color-accent)" strokeWidth={1.4} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
