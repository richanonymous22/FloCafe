'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Line, LineChart, ResponsiveContainer, BarChart, Bar, Cell, ReferenceLine,
  XAxis, PieChart, Pie,
} from 'recharts';
import {
  Banknote, Receipt, TrendingUp, ShoppingBag, ArrowUpRight, ArrowDownRight,
  Download, ArrowRight,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import { useI18n } from '@/hooks/useI18n';
import toast from 'react-hot-toast';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { getCountryByCode } from '@/lib/countries';
import { PAYMENT_METHODS } from '@/lib/payment-methods';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from '@/components/ui/chart';
import { cn } from '@/lib/utils';

interface PMBreakdown { method: string | null; count: number; total: number; }
interface DailyStats { sales: number; runningOrders: number; pendingOrders: number; tablesOccupied: number; paymentMethods: PMBreakdown[]; }
interface TopProduct { product_id: number; product_name: string; total_quantity: number; total_revenue: number; order_count: number; }
interface TopCategory { category_id: string | null; name: string; quantity: number; revenue: number; }
interface Insights { windowDays: number; aov: number; avgPrepTimeMinutes: number | null; topCategories: TopCategory[]; }
interface DailySales { date: string; orders: number; sales: number; }
interface SalesReport { dailySales: DailySales[]; byPaymentMethod: PMBreakdown[]; }

const RANGES = [{ key: 'today', days: 1 }, { key: '7d', days: 7 }, { key: '30d', days: 30 }] as const;
type RangeKey = typeof RANGES[number]['key'];
const DOT_COLORS = ['var(--chart-1)', 'var(--chart-5)', 'var(--chart-3)', 'var(--chart-2)', 'var(--chart-4)'];

function localDate(d: Date, tz: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function pctChange(series: number[]): number | null {
  if (series.length < 4) return null;
  const half = Math.floor(series.length / 2);
  const a = series.slice(0, half).reduce((s, v) => s + v, 0) / half;
  const b = series.slice(half).reduce((s, v) => s + v, 0) / (series.length - half);
  if (a === 0) return null;
  return ((b - a) / a) * 100;
}

export default function DashboardPage() {
  const { currentTenant } = useAuthStore();
  const { t } = useI18n();
  const router = useRouter();
  const fmt = useFormatCurrency();

  const isOwner = currentTenant?.role === 'owner';
  const locale = currentTenant?.country ? (getCountryByCode(currentTenant.country)?.locale ?? 'en-US') : 'en-US';
  const tz = currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = localDate(new Date(), tz);
  const todayLabel = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz }).format(new Date());

  const [range, setRange] = useState<RangeKey>('7d');
  const [stats, setStats] = useState<DailyStats | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [salesReport, setSalesReport] = useState<SalesReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { if (currentTenant && !isOwner) router.replace('/pos'); }, [currentTenant, isOwner, router]);

  const days = RANGES.find((r) => r.key === range)!.days;
  const rangeStart = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() - (Math.max(days, 14) - 1)); return localDate(d, tz);
  }, [days, tz]);

  const [syncedKey, setSyncedKey] = useState(rangeStart);
  if (rangeStart !== syncedKey) { setSyncedKey(rangeStart); if (isOwner) setLoading(true); }

  useEffect(() => {
    if (!isOwner) return;
    const c = new AbortController();
    Promise.all([
      api.get('/reports/daily-stats', { signal: c.signal }),
      api.get('/reports/insights', { params: { days: 30 }, signal: c.signal }),
      api.get('/reports/topProducts', { params: { start_date: rangeStart, end_date: today, limit: 5 }, signal: c.signal }),
      api.get('/reports/sales', { params: { start_date: rangeStart, end_date: today }, signal: c.signal }),
    ])
      .then(([s, ins, tp, sr]) => {
        setStats(s.data); setInsights(ins.data);
        setTopProducts(tp.data.topProducts || []); setSalesReport(sr.data.sales || null);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) return;
        toast.error(t('common.somethingWrong'));
      })
      .finally(() => { if (!c.signal.aborted) setLoading(false); });
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner, rangeStart]);

  const trend = useMemo(() => {
    const rows = (salesReport?.dailySales ?? []).slice(-days > -14 ? -14 : -days);
    return rows.map((r) => ({
      label: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${r.date}T00:00:00Z`)),
      sales: Number(r.sales) || 0, orders: Number(r.orders) || 0,
    }));
  }, [salesReport, locale, days]);

  const salesSeries = trend.map((d) => d.sales);
  const ordersSeries = trend.map((d) => d.orders);
  const aovSeries = trend.map((d) => (d.orders > 0 ? d.sales / d.orders : 0));
  const avgSales = salesSeries.length ? salesSeries.reduce((s, v) => s + v, 0) / salesSeries.length : 0;
  const maxIdx = salesSeries.reduce((mi, v, i, a) => (v > a[mi] ? i : mi), 0);

  const paymentData = useMemo(() => {
    const rows = salesReport?.byPaymentMethod?.length ? salesReport.byPaymentMethod : (stats?.paymentMethods ?? []);
    return rows.map((pm) => {
      const meta = PAYMENT_METHODS.find((m) => m.key === pm.method);
      return { key: pm.method ?? 'unknown', label: meta ? t(meta.labelKey) : String(pm.method || t('common.unknown')), total: Number(pm.total) || 0 };
    }).filter((p) => p.total > 0);
  }, [salesReport, stats, t]);
  const paymentTotal = paymentData.reduce((s, p) => s + p.total, 0);
  const productRevMax = Math.max(1, ...topProducts.map((p) => Number(p.total_revenue) || 0));

  if (!isOwner) return null;

  const kpis = [
    { label: t('dashboard.todaySales'), value: fmt(stats?.sales ?? 0), icon: Banknote, tint: 'bg-accent text-primary', series: salesSeries, color: 'var(--chart-1)', delta: pctChange(salesSeries) },
    { label: t('dashboard.orders'), value: String(ordersSeries.reduce((s, v) => s + v, 0)), icon: ShoppingBag, tint: 'bg-info-tint text-info', series: ordersSeries, color: 'var(--chart-2)', delta: pctChange(ordersSeries) },
    { label: t('dashboard.aov'), value: fmt(insights?.aov ?? 0), icon: Receipt, tint: 'bg-success-tint text-success', series: aovSeries, color: 'var(--chart-3)', delta: pctChange(aovSeries) },
    { label: t('dashboard.runningOrders'), value: String(stats?.runningOrders ?? 0), icon: TrendingUp, tint: 'bg-purple-tint text-purple', series: [], color: 'var(--chart-4)', delta: null },
  ];

  const barConfig = { sales: { label: t('dashboard.sales'), color: 'var(--chart-1)' } } satisfies ChartConfig;

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5">
      {/* Masthead */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">{t('dashboard.overview')}</h2>
          <p className="mt-0.5 text-sm capitalize text-text-subtle">{todayLabel}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-xl border border-hairline bg-surface p-1 shadow-xs">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={cn(
                  'rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors',
                  range === r.key ? 'bg-accent text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {r.key === 'today' ? 'Today' : `${r.days} days`}
              </button>
            ))}
          </div>
          <button className="inline-flex h-10 items-center gap-2 rounded-xl border border-hairline bg-surface px-4 text-sm font-semibold shadow-xs transition-colors hover:bg-hover">
            <Download className="size-4" /> Export
          </button>
        </div>
      </div>

      {loading ? (
        <Sk />
      ) : (
        <div className="animate-rise space-y-5">
          {/* KPI row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {kpis.map((k) => (
              <Card key={k.label} className="gap-0 rounded-2xl p-5 shadow-sm">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className={cn('flex size-9 items-center justify-center rounded-xl', k.tint)}>
                      <k.icon className="size-[18px]" />
                    </span>
                    <span className="text-sm font-medium text-muted-foreground">{k.label}</span>
                  </div>
                  {k.series.length > 1 && (
                    <div className="h-8 w-20">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={k.series.map((v) => ({ v }))}>
                          <Line type="monotone" dataKey="v" stroke={k.color} strokeWidth={2} dot={false} isAnimationActive={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
                <p className="mt-3 text-4xl font-bold tracking-tight tabular-nums">{k.value}</p>
                <div className="mt-3 flex items-center gap-2">
                  {k.delta != null ? (
                    <span className={cn(
                      'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-bold',
                      k.delta >= 0 ? 'bg-success-tint text-success' : 'bg-danger-tint text-destructive'
                    )}>
                      {k.delta >= 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
                      {Math.abs(k.delta).toFixed(1)}%
                    </span>
                  ) : <span className="text-xs text-text-subtle">{stats?.pendingOrders ?? 0} {t('dashboard.pendingOrders').toLowerCase()}</span>}
                  {k.delta != null && <span className="text-xs text-text-subtle">vs previous period</span>}
                </div>
              </Card>
            ))}
          </div>

          {/* Sales overview + Trending */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="gap-0 rounded-2xl p-6 shadow-sm lg:col-span-2">
              <div className="mb-5 flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold">{t('dashboard.sales')}</h3>
                  <p className="text-sm text-text-subtle">{fmt(salesSeries.reduce((s, v) => s + v, 0))} · {t('dashboard.title')} {days}d</p>
                </div>
                <Link href="/orders" className="inline-flex items-center gap-1 rounded-lg border border-hairline px-3 py-1.5 text-sm font-semibold transition-colors hover:bg-hover">
                  {t('dashboard.viewAll')} <ArrowRight className="size-3.5" />
                </Link>
              </div>
              {trend.length === 0 ? (
                <Empty label={t('dashboard.noSalesYet')} />
              ) : (
                <ChartContainer config={barConfig} className="h-[260px] w-full">
                  <BarChart data={trend} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
                    <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={20} />
                    <ChartTooltip cursor={false} content={<ChartTooltipContent labelKey="label" formatter={(v) => fmt(Number(v))} />} />
                    <ReferenceLine y={avgSales} stroke="var(--border-strong)" strokeDasharray="4 4" />
                    <Bar dataKey="sales" radius={[6, 6, 6, 6]} barSize={26}>
                      {trend.map((_, i) => <Cell key={i} fill={i === maxIdx ? 'var(--chart-1)' : 'var(--muted)'} />)}
                    </Bar>
                  </BarChart>
                </ChartContainer>
              )}
              <div className="mt-4 flex items-center gap-5 text-xs text-muted-foreground">
                <Legend color="var(--chart-1)" label={t('dashboard.sales')} />
                <Legend color="var(--muted)" label="Other days" />
                <Legend dashed label="Average" />
              </div>
            </Card>

            <Card className="gap-0 rounded-2xl p-6 shadow-sm">
              <div className="mb-4 flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold">{t('dashboard.topProductsToday')}</h3>
                  <p className="text-sm text-text-subtle">{t('dashboard.title')}</p>
                </div>
              </div>
              {topProducts.length === 0 ? (
                <Empty label={t('dashboard.noSalesYet')} />
              ) : (
                <div className="-mx-2 divide-y divide-hairline">
                  {topProducts.map((p, i) => (
                    <div key={p.product_id} className="flex items-center gap-3 px-2 py-3">
                      <span className="w-5 text-sm font-bold tabular-nums text-text-subtle">{String(i + 1).padStart(2, '0')}</span>
                      <span className="size-2.5 shrink-0 rounded-full" style={{ background: DOT_COLORS[i % DOT_COLORS.length] }} />
                      <span className="flex-1 truncate text-sm font-semibold">{p.product_name}</span>
                      <div className="text-right">
                        <p className="text-sm font-bold tabular-nums">{fmt(Number(p.total_revenue))}</p>
                        <p className="text-xs text-text-subtle tabular-nums">{p.total_quantity} sold</p>
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center justify-between px-2 pt-3 text-sm">
                    <span className="font-medium text-muted-foreground">Total from top {topProducts.length}</span>
                    <span className="font-bold tabular-nums">{fmt(topProducts.reduce((s, p) => s + Number(p.total_revenue), 0))}</span>
                  </div>
                </div>
              )}
            </Card>
          </div>

          {/* Payment methods + Top categories */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="gap-0 rounded-2xl p-6 shadow-sm">
              <h3 className="text-lg font-bold">{t('dashboard.paymentMethods')}</h3>
              <p className="mb-2 text-sm text-text-subtle">{fmt(paymentTotal)}</p>
              {paymentData.length === 0 ? <Empty label={t('dashboard.noPaymentsYet')} /> : (
                <div className="flex items-center gap-4">
                  <div className="relative size-32 shrink-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={paymentData} dataKey="total" nameKey="label" innerRadius={40} outerRadius={62} paddingAngle={2} strokeWidth={0}>
                          {paymentData.map((_, i) => <Cell key={i} fill={DOT_COLORS[i % DOT_COLORS.length]} />)}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex-1 space-y-2">
                    {paymentData.map((p, i) => (
                      <div key={p.key} className="flex items-center gap-2 text-sm">
                        <span className="size-2.5 rounded-full" style={{ background: DOT_COLORS[i % DOT_COLORS.length] }} />
                        <span className="flex-1 truncate text-muted-foreground">{p.label}</span>
                        <span className="font-bold tabular-nums">{Math.round((p.total / paymentTotal) * 100)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            <Card className="gap-0 rounded-2xl p-6 shadow-sm lg:col-span-2">
              <h3 className="mb-4 text-lg font-bold">{t('dashboard.topCategories')}</h3>
              {(insights?.topCategories.length ?? 0) === 0 ? <Empty label={t('dashboard.noSalesYet')} /> : (
                <div className="space-y-3.5">
                  {insights!.topCategories.slice(0, 5).map((c, i) => {
                    const max = Math.max(1, ...insights!.topCategories.map((x) => Number(x.revenue)));
                    return (
                      <div key={c.category_id ?? c.name} className="space-y-1.5">
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-semibold">{c.name}</span>
                          <span className="font-bold tabular-nums">{fmt(Number(c.revenue))}</span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full" style={{ width: `${(Number(c.revenue) / max) * 100}%`, background: DOT_COLORS[i % DOT_COLORS.length] }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
          <div className="text-[11px] text-text-subtle">Top product revenue peaks at {fmt(productRevMax)}.</div>
        </div>
      )}
    </div>
  );
}

function Legend({ color, label, dashed }: { color?: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {dashed ? <span className="h-0 w-4 border-t-2 border-dashed border-border-strong" /> : <span className="size-2.5 rounded-sm" style={{ background: color }} />}
      {label}
    </span>
  );
}
function Empty({ label }: { label: string }) {
  return <div className="flex h-[200px] items-center justify-center text-sm text-text-subtle">{label}</div>;
}
function Sk() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Skeleton className="h-96 rounded-2xl lg:col-span-2" /><Skeleton className="h-96 rounded-2xl" />
      </div>
    </div>
  );
}
