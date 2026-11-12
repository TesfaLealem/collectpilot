// Chart building blocks. One y-axis per chart, recessive grid, tooltips on every mark, text in ink (never series colour).
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { compact, money } from './api';

export const C = { expected: '#2a78d6', best: '#1baf7a', worst: '#eb6834', grid: '#e6e5e0', ink2: '#52514e' };
const axis = { tick: { fontSize: 11, fill: C.ink2 }, tickLine: false, axisLine: { stroke: C.grid } };
const tip = { contentStyle: { fontSize: 12, borderRadius: 6, border: `1px solid ${C.grid}`, color: '#0b0b0b' }, itemStyle: { color: '#0b0b0b' }, labelStyle: { color: C.ink2, marginBottom: 2 } };

export function ForecastChart({ weeks, compare }: { weeks: { index: number; start: string; best: number; expected: number; worst: number }[]; compare?: { simulated: number }[] }) {
  const data = weeks.map((w, i) => ({ name: `W${w.index}`, start: w.start, Expected: w.expected, Best: w.best, Worst: w.worst, ...(compare ? { 'If late': compare[i]?.simulated ?? 0 } : {}) }));
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="name" {...axis} />
        <YAxis {...axis} axisLine={false} width={48} tickFormatter={(v) => compact(v)} />
        <Tooltip {...tip} formatter={(v) => money(Number(v))} labelFormatter={(l, p) => `${l}, week of ${p?.[0]?.payload?.start ?? ''}`} />
        <Legend iconSize={10} wrapperStyle={{ fontSize: 12, color: C.ink2 }} formatter={(v) => <span style={{ color: C.ink2 }}>{v}</span>} />
        <Bar dataKey="Expected" fill={C.expected} radius={[4, 4, 0, 0]} maxBarSize={26} />
        {compare && <Bar dataKey="If late" fill={C.worst} radius={[4, 4, 0, 0]} maxBarSize={26} />}
        {!compare && <Line dataKey="Best" stroke={C.best} strokeWidth={2} dot={false} type="monotone" />}
        {!compare && <Line dataKey="Worst" stroke={C.worst} strokeWidth={2} dot={false} type="monotone" strokeDasharray="5 4" />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function AgingChart({ aging }: { aging: { label: string; cents: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={aging.map((a) => ({ name: a.label, Outstanding: a.cents }))} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="name" {...axis} />
        <YAxis {...axis} axisLine={false} width={48} tickFormatter={(v) => compact(v)} />
        <Tooltip {...tip} cursor={{ fill: '#00000008' }} formatter={(v) => money(Number(v))} labelFormatter={(l) => `Days past due: ${l}`} />
        <Bar dataKey="Outstanding" fill={C.expected} radius={[4, 4, 0, 0]} maxBarSize={44} label={{ position: 'top', fontSize: 11, fill: C.ink2, formatter: (v: any) => compact(Number(v)) }} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DsoChart({ trend }: { trend: { week: string; dso: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={trend.map((t) => ({ name: t.week.slice(5), 'DSO (days)': t.dso }))} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="name" {...axis} />
        <YAxis {...axis} axisLine={false} width={32} domain={['auto', 'auto']} />
        <Tooltip {...tip} formatter={(v) => `${v} days`} />
        <Line dataKey="DSO (days)" stroke={C.expected} strokeWidth={2} dot={{ r: 3, strokeWidth: 0, fill: C.expected }} activeDot={{ r: 5 }} type="monotone" />
      </LineChart>
    </ResponsiveContainer>
  );
}
