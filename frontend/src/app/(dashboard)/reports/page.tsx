'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Area, AreaChart, CartesianGrid, XAxis, YAxis, PieChart, Pie, Cell, BarChart, Bar,
} from 'recharts';
import { Download, TrendingDown } from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import { useI18n } from '@/hooks/useI18n';
import toast from 'react-hot-toast';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { getCountryByCode } from '@/lib/countries';
import { PAYMENT_METHODS } from '@/lib/payment-methods';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { cn } from '@/lib/utils';

interface Breakdown { method?: string | null; type?: string; count: number; total: number; }
interface DailySales { date: string; orders: number; sales: number; }
interface SalesReport { startDate: string; endDate: string; dailySales: DailySales[]; byPaymentMethod: Breakdown[]; byOrderType: Breakdown[]; }

const RANGES = [{ key: '7d', days: 7 }, { key: '30d', days: 30 }, { key: '90d', days: 90 }] as const;
type RangeKey = typeof RANGES[number]['key'];
type Metric = 'sales' | 'orders' | 'basket';
const DOT = ['var(--chart-1)', 'var(--chart-5)', 'var(--chart-3)', 'var(--chart-2)', 'var(--chart-4)'];
const ORDER_TYPE_LABEL: Record<string, string> = { dine_in: 'Dine in', dinein: 'Dine in', takeaway: 'Takeaway', delivery: 'Delivery', collection: 'Collection', retail: 'Counter' };

function localDate(d: Date, tz: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export default function ReportsPage() {
  const { currentTenant } = useAuthStore();
  const { t } = useI18n();
  const router = useRouter();
  const fmt = useFormatCurrency();

  const canView = currentTenant?.role === 'owner' || currentTenant?.role === 'manager';
  const locale = currentTenant?.country ? (getCountryByCode(currentTenant.country)?.locale ?? 'en-US') : 'en-US';
  const tz = currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = localDate(new Date(), tz);

  const [range, setRange] = useState<RangeKey>('30d');
  const [metric, setMetric] = useState<Metric>('sales');
  const [report, setReport] = useState<SalesReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { if (currentTenant && !canView) router.replace('/pos'); }, [currentTenant, canView, router]);

  const days = RANGES.find((r) => r.key === range)!.days;
  const rangeStart = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - (days - 1)); return localDate(d, tz); }, [days, tz]);

  const [syncedKey, setSyncedKey] = useState(rangeStart);
  if (rangeStart !== syncedKey) { setSyncedKey(rangeStart); if (canView) setLoading(true); }

  useEffect(() => {
    if (!canView) return;
    const c = new AbortController();
    api.get('/reports/sales', { params: { start_date: rangeStart, end_date: today }, signal: c.signal })
      .then((r) => setReport(r.data.sales || null))
      .catch((err: unknown) => { if (!(err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))) toast.error(t('common.somethingWrong')); })
      .finally(() => { if (!c.signal.aborted) setLoading(false); });
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, rangeStart]);

  const rows = useMemo(() => (report?.dailySales ?? []).map((d) => {
    const sales = Number(d.sales) || 0; const orders = Number(d.orders) || 0;
    return {
      date: d.date,
      label: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d.date}T00:00:00Z`)),
      sales, orders, basket: orders > 0 ? sales / orders : 0,
    };
  }), [report, locale]);

  const totalSales = rows.reduce((s, r) => s + r.sales, 0);
  const totalOrders = rows.reduce((s, r) => s + r.orders, 0);
  const avgBasket = totalOrders > 0 ? totalSales / totalOrders : 0;
  // period-over-period delta on the active metric
  const delta = useMemo(() => {
    const series = rows.map((r) => r[metric]);
    if (series.length < 4) return null;
    const h = Math.floor(series.length / 2);
    const a = series.slice(0, h).reduce((s, v) => s + v, 0) / h;
    const b = series.slice(h).reduce((s, v) => s + v, 0) / (series.length - h);
    return a === 0 ? null : ((b - a) / a) * 100;
  }, [rows, metric]);

  const payments = useMemo(() => (report?.byPaymentMethod ?? []).map((pm) => {
    const meta = PAYMENT_METHODS.find((m) => m.key === pm.method);
    return { key: pm.method ?? 'unknown', label: meta ? t(meta.labelKey) : String(pm.method || t('common.unknown')), total: Number(pm.total) || 0 };
  }).filter((p) => p.total > 0), [report, t]);
  const paymentTotal = payments.reduce((s, p) => s + p.total, 0);

  const orderTypes = useMemo(() => (report?.byOrderType ?? []).map((o) => ({
    label: ORDER_TYPE_LABEL[String(o.type)] ?? String(o.type), total: Number(o.total) || 0, count: o.count,
  })).filter((o) => o.total > 0).sort((a, b) => b.total - a.total), [report]);

  function exportCsv() {
    const header = 'date,orders,sales,avg_basket\n';
    const body = rows.map((r) => `${r.date},${r.orders},${r.sales.toFixed(2)},${r.basket.toFixed(2)}`).join('\n');
    const blob = new Blob([header + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `plemmo-sales-${rangeStart}_to_${today}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  if (!canView) return null;

  const metricValue = metric === 'sales' ? fmt(totalSales) : metric === 'orders' ? String(totalOrders) : fmt(avgBasket);
  const metricLabel = metric === 'sales' ? t('dashboard.sales') : metric === 'orders' ? t('dashboard.orders') : 'Avg basket';
  const areaConfig = { [metric]: { label: metricLabel, color: 'var(--chart-1)' } } as ChartConfig;
  const fmtAxis = (v: number) => (metric === 'orders' ? String(v) : fmt(v).replace(/\.00$/, ''));

  const metrics: { key: Metric; label: string }[] = [
    { key: 'sales', label: t('dashboard.sales') }, { key: 'orders', label: t('dashboard.orders') }, { key: 'basket', label: 'Avg basket' },
  ];

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5">
      {/* masthead */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">{t('nav.reports')}</h2>
          <p className="mt-0.5 text-sm text-text-subtle">Pick a metric and a window. Export the daily series any time.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-xl border border-hairline bg-surface p-1 shadow-xs">
            {RANGES.map((r) => (
              <button key={r.key} onClick={() => setRange(r.key)} className={cn('rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors', range === r.key ? 'bg-accent text-primary' : 'text-muted-foreground hover:text-foreground')}>{r.days} days</button>
            ))}
          </div>
          <button onClick={exportCsv} className="inline-flex h-10 items-center gap-2 rounded-xl border border-hairline bg-surface px-4 text-sm font-semibold shadow-xs transition-colors hover:bg-hover"><Download className="size-4" /> Export CSV</button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-5">
          <Skeleton className="h-[420px] rounded-2xl" />
          <div className="grid gap-4 lg:grid-cols-2"><Skeleton className="h-72 rounded-2xl" /><Skeleton className="h-72 rounded-2xl" /></div>
        </div>
      ) : (
        <div className="animate-rise space-y-5">
          {/* headline metric + chart */}
          <Card className="gap-0 rounded-2xl p-6 shadow-sm">
            <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="eyebrow">{metricLabel}</p>
                <div className="mt-1 flex items-center gap-3">
                  <span className="text-4xl font-bold tracking-tight tabular-nums">{metricValue}</span>
                  {delta != null && (
                    <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold', delta >= 0 ? 'bg-success-tint text-success' : 'bg-danger-tint text-destructive')}>
                      {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}%
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-text-subtle">Last {days} days · {rows.length} trading days</p>
              </div>
              <div className="flex items-center gap-0.5 self-start rounded-xl border border-hairline bg-surface p-1">
                {metrics.map((m) => (
                  <button key={m.key} onClick={() => setMetric(m.key)} className={cn('rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors', metric === m.key ? 'bg-accent text-primary' : 'text-muted-foreground hover:text-foreground')}>{m.label}</button>
                ))}
              </div>
            </div>
            {rows.length === 0 ? <Empty label={t('dashboard.noSalesYet')} /> : (
              <ChartContainer config={areaConfig} className="h-[300px] w-full">
                <AreaChart data={rows} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                  <defs>
                    <linearGradient id="fillMetric" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={28} />
                  <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={fmtAxis} />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent labelKey="label" formatter={(v) => (metric === 'orders' ? String(v) : fmt(Number(v)))} />} />
                  <Area dataKey={metric} type="natural" stroke="var(--chart-1)" strokeWidth={2.5} fill="url(#fillMetric)" />
                </AreaChart>
              </ChartContainer>
            )}
          </Card>

          {/* payments + order types */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="gap-0 rounded-2xl p-6 shadow-sm">
              <h3 className="text-lg font-bold">{t('dashboard.paymentMethods')}</h3>
              <p className="mb-3 text-sm text-text-subtle">{fmt(paymentTotal)} · {days} days</p>
              {payments.length === 0 ? <Empty label={t('dashboard.noPaymentsYet')} /> : (
                <div className="flex items-center gap-6">
                  <div className="relative size-40 shrink-0">
                    <ChartContainer config={{}} className="size-40">
                      <PieChart>
                        <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="label" formatter={(v) => fmt(Number(v))} />} />
                        <Pie data={payments} dataKey="total" nameKey="label" innerRadius={48} outerRadius={76} paddingAngle={2} strokeWidth={0}>
                          {payments.map((_, i) => <Cell key={i} fill={DOT[i % DOT.length]} />)}
                        </Pie>
                      </PieChart>
                    </ChartContainer>
                  </div>
                  <div className="flex-1 space-y-2.5">
                    {payments.map((p, i) => (
                      <div key={p.key} className="flex items-center gap-2 text-sm">
                        <span className="size-2.5 rounded-full" style={{ background: DOT[i % DOT.length] }} />
                        <span className="flex-1 truncate text-muted-foreground">{p.label}</span>
                        <span className="font-bold tabular-nums">{fmt(p.total)}</span>
                        <span className="w-10 text-right text-xs text-text-subtle tabular-nums">{Math.round((p.total / paymentTotal) * 100)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            <Card className="gap-0 rounded-2xl p-6 shadow-sm">
              <h3 className="text-lg font-bold">Where the sales come from</h3>
              <p className="mb-4 text-sm text-text-subtle">By order channel · {days} days</p>
              {orderTypes.length === 0 ? <Empty label={t('dashboard.noSalesYet')} /> : (
                <ChartContainer config={{}} className="h-[220px] w-full">
                  <BarChart data={orderTypes} layout="vertical" margin={{ left: 8, right: 16 }}>
                    <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={80} tick={{ fontSize: 12 }} />
                    <ChartTooltip content={<ChartTooltipContent hideLabel formatter={(v) => fmt(Number(v))} />} />
                    <Bar dataKey="total" radius={[0, 6, 6, 0]} barSize={26}>
                      {orderTypes.map((_, i) => <Cell key={i} fill={DOT[i % DOT.length]} />)}
                    </Bar>
                  </BarChart>
                </ChartContainer>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <div className="flex h-[220px] flex-col items-center justify-center gap-2 text-sm text-text-subtle"><TrendingDown className="size-6 opacity-40" />{label}</div>;
}
