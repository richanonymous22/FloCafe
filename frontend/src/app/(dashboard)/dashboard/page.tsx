'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Area, AreaChart, CartesianGrid, XAxis, YAxis,
  PieChart, Pie, Cell, BarChart, Bar,
} from 'recharts';
import {
  Banknote, TrendingUp, TrendingDown, Timer, Receipt, ArrowRight,
  ArrowUpRight, ArrowDownRight, ShoppingBag, Trophy,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import { useI18n } from '@/hooks/useI18n';
import toast from 'react-hot-toast';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { getCountryByCode } from '@/lib/countries';
import { PAYMENT_METHODS } from '@/lib/payment-methods';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from '@/components/ui/chart';

// ── Types (mirror the report endpoints) ─────────────────────────────────
interface PMBreakdown { method: string | null; count: number; total: number; }
interface DailyStats { sales: number; runningOrders: number; pendingOrders: number; tablesOccupied: number; paymentMethods: PMBreakdown[]; }
interface TopProduct { product_id: number; product_name: string; total_quantity: number; total_revenue: number; order_count: number; }
interface RecentOrder { id: number; order_number: string; status: string; total: number; customer_name: string | null; table_name: string | null; created_at: string; }
interface TopStaff { user_id: string; name: string; role: string; revenue: number; orderCount: number; }
interface TopCategory { category_id: string | null; name: string; quantity: number; revenue: number; }
interface Insights { windowDays: number; aov: number; avgPrepTimeMinutes: number | null; topStaff: TopStaff[]; topCategories: TopCategory[]; }
interface DailySales { date: string; orders: number; sales: number; }
interface SalesReport { dailySales: DailySales[]; byPaymentMethod: PMBreakdown[]; byOrderType: { type: string; count: number; total: number }[]; }

const RANGES = [
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
  { key: '90d', days: 90 },
] as const;
type RangeKey = typeof RANGES[number]['key'];

const CHART_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

function localDate(date: Date, tz: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
const orderStatusVariant: Record<string, 'default' | 'secondary' | 'outline'> = {
  pending: 'outline', preparing: 'secondary', ready: 'default', served: 'secondary', completed: 'outline', cancelled: 'outline',
};

export default function DashboardPage() {
  const { currentTenant } = useAuthStore();
  const { t } = useI18n();
  const router = useRouter();
  const fmt = useFormatCurrency();

  const isOwner = currentTenant?.role === 'owner';
  const locale = currentTenant?.country ? (getCountryByCode(currentTenant.country)?.locale ?? 'en-US') : 'en-US';
  const tz = currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = localDate(new Date(), tz);

  const [range, setRange] = useState<RangeKey>('7d');
  const [stats, setStats] = useState<DailyStats | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [salesReport, setSalesReport] = useState<SalesReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (currentTenant && !isOwner) router.replace('/pos');
  }, [currentTenant, isOwner, router]);

  const days = RANGES.find((r) => r.key === range)!.days;
  const rangeStart = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1));
    return localDate(d, tz);
  }, [days, tz]);

  // Show the loading state the moment the range changes — adjusting state
  // during render (React's recommended pattern) rather than inside the effect.
  const [syncedKey, setSyncedKey] = useState(rangeStart);
  if (rangeStart !== syncedKey) {
    setSyncedKey(rangeStart);
    if (isOwner) setLoading(true);
  }

  useEffect(() => {
    if (!isOwner) return;
    const c = new AbortController();
    Promise.all([
      api.get('/reports/daily-stats', { signal: c.signal }),
      api.get('/reports/insights', { params: { days: 30 }, signal: c.signal }),
      api.get('/reports/topProducts', { params: { start_date: today, end_date: today, limit: 5 }, signal: c.signal }),
      api.get('/reports/recentOrders', { params: { date: today, limit: 6 }, signal: c.signal }),
      api.get('/reports/sales', { params: { start_date: rangeStart, end_date: today }, signal: c.signal }),
    ])
      .then(([s, ins, tp, ro, sr]) => {
        setStats(s.data);
        setInsights(ins.data);
        setTopProducts(tp.data.topProducts || []);
        setRecentOrders(ro.data.recentOrders || []);
        setSalesReport(sr.data.sales || null);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) return;
        toast.error(t('common.somethingWrong'));
      })
      .finally(() => { if (!c.signal.aborted) setLoading(false); });
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner, rangeStart]);

  const trendData = useMemo(() => {
    const rows = salesReport?.dailySales ?? [];
    return rows.map((r) => ({
      date: r.date,
      label: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${r.date}T00:00:00Z`)),
      sales: Number(r.sales) || 0,
      orders: Number(r.orders) || 0,
    }));
  }, [salesReport, locale]);

  const rangeTotal = trendData.reduce((s, r) => s + r.sales, 0);
  const rangeOrders = trendData.reduce((s, r) => s + r.orders, 0);
  // Sales delta: last day vs the day before (when available).
  const salesDelta = useMemo(() => {
    if (trendData.length < 2) return null;
    const last = trendData[trendData.length - 1].sales;
    const prev = trendData[trendData.length - 2].sales;
    if (prev === 0) return null;
    return ((last - prev) / prev) * 100;
  }, [trendData]);

  const paymentData = useMemo(() => {
    const rows = salesReport?.byPaymentMethod?.length ? salesReport.byPaymentMethod : (stats?.paymentMethods ?? []);
    return rows.map((pm) => {
      const meta = PAYMENT_METHODS.find((m) => m.key === pm.method);
      return { key: pm.method ?? 'unknown', label: meta ? t(meta.labelKey) : String(pm.method || t('common.unknown')), total: Number(pm.total) || 0, count: pm.count };
    }).filter((p) => p.total > 0);
  }, [salesReport, stats, t]);
  const paymentTotal = paymentData.reduce((s, p) => s + p.total, 0);

  const categoryData = useMemo(() =>
    (insights?.topCategories ?? []).slice(0, 5).map((c) => ({ name: c.name, revenue: Number(c.revenue) || 0 })),
  [insights]);

  const productMax = Math.max(1, ...topProducts.map((p) => Number(p.total_revenue) || 0));
  const staffMax = Math.max(1, ...(insights?.topStaff ?? []).map((s) => Number(s.revenue) || 0));

  if (!isOwner) return null;

  const trendConfig = { sales: { label: t('dashboard.sales'), color: 'var(--chart-1)' } } satisfies ChartConfig;
  const paymentConfig: ChartConfig = Object.fromEntries(
    paymentData.map((p, i) => [p.key, { label: p.label, color: CHART_COLORS[i % CHART_COLORS.length] }])
  );
  const categoryConfig = { revenue: { label: t('dashboard.sales'), color: 'var(--chart-1)' } } satisfies ChartConfig;

  const kpis = [
    {
      label: t('dashboard.todaySales'), value: fmt(stats?.sales ?? 0), icon: Banknote,
      delta: salesDelta, foot: `${fmt(rangeTotal)} over ${days}d`,
    },
    {
      label: t('dashboard.aov'), value: fmt(insights?.aov ?? 0), icon: Receipt,
      delta: null, foot: `${rangeOrders} ${t('dashboard.orders').toLowerCase()} · ${days}d`,
    },
    {
      label: t('dashboard.runningOrders'), value: String(stats?.runningOrders ?? 0), icon: ShoppingBag,
      delta: null, foot: `${stats?.pendingOrders ?? 0} ${t('dashboard.pendingOrders').toLowerCase()}`,
    },
    {
      label: t('dashboard.avgPrepTime'),
      value: insights?.avgPrepTimeMinutes != null ? `${insights.avgPrepTimeMinutes}m` : '—', icon: Timer,
      delta: null, foot: '30-day average',
    },
  ];

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-6 p-1">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('dashboard.title')}</h1>
          <p className="text-sm text-muted-foreground">{currentTenant?.business_name}</p>
        </div>
        <Tabs value={range} onValueChange={(v) => setRange(v as RangeKey)}>
          <TabsList>
            {RANGES.map((r) => (
              <TabsTrigger key={r.key} value={r.key}>{r.days}d</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {loading ? (
        <DashboardSkeleton />
      ) : (
        <div className="animate-rise space-y-6">
          {/* KPI cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {kpis.map((k) => (
              <Card key={k.label} className="gap-0 py-0">
                <CardHeader className="gap-1 pt-5 pb-0">
                  <CardDescription className="flex items-center justify-between">
                    <span>{k.label}</span>
                    <k.icon className="size-4 text-muted-foreground" />
                  </CardDescription>
                  <CardTitle className="text-3xl font-semibold tabular-nums tracking-tight">{k.value}</CardTitle>
                </CardHeader>
                <CardFooter className="flex items-center gap-2 pt-3 pb-5 text-xs text-muted-foreground">
                  {k.delta != null && (
                    <Badge variant="secondary" className={k.delta >= 0 ? 'text-success' : 'text-destructive'}>
                      {k.delta >= 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
                      {Math.abs(k.delta).toFixed(1)}%
                    </Badge>
                  )}
                  <span className="truncate">{k.foot}</span>
                </CardFooter>
              </Card>
            ))}
          </div>

          {/* Trend + payments */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>{t('dashboard.sales')}</CardTitle>
                <CardDescription>
                  {fmt(rangeTotal)} · {rangeOrders} {t('dashboard.orders').toLowerCase()} · {t('dashboard.title')} {days}d
                </CardDescription>
              </CardHeader>
              <CardContent>
                {trendData.length === 0 ? (
                  <EmptyChart label={t('dashboard.noSalesYet')} />
                ) : (
                  <ChartContainer config={trendConfig} className="h-[260px] w-full">
                    <AreaChart data={trendData} margin={{ left: 4, right: 12, top: 8 }}>
                      <defs>
                        <linearGradient id="fillSales" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--color-sales)" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="var(--color-sales)" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} strokeDasharray="3 3" />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} minTickGap={24} />
                      <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v) => fmt(Number(v)).replace(/\.00$/, '')} />
                      <ChartTooltip content={<ChartTooltipContent indicator="dot" labelKey="label" formatter={(val) => fmt(Number(val))} />} />
                      <Area dataKey="sales" type="natural" fill="url(#fillSales)" stroke="var(--color-sales)" strokeWidth={2} />
                    </AreaChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>

            <Card className="flex flex-col">
              <CardHeader>
                <CardTitle>{t('dashboard.paymentMethods')}</CardTitle>
                <CardDescription>{fmt(paymentTotal)} · {days}d</CardDescription>
              </CardHeader>
              <CardContent className="flex-1">
                {paymentData.length === 0 ? (
                  <EmptyChart label={t('dashboard.noPaymentsYet')} />
                ) : (
                  <>
                    <ChartContainer config={paymentConfig} className="mx-auto aspect-square max-h-[180px]">
                      <PieChart>
                        <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="label" formatter={(val) => fmt(Number(val))} />} />
                        <Pie data={paymentData} dataKey="total" nameKey="label" innerRadius={52} strokeWidth={3} paddingAngle={2}>
                          {paymentData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                        </Pie>
                      </PieChart>
                    </ChartContainer>
                    <div className="mt-2 space-y-2">
                      {paymentData.map((p, i) => (
                        <div key={p.key} className="flex items-center gap-2 text-sm">
                          <span className="size-2.5 rounded-full" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                          <span className="flex-1 truncate text-muted-foreground">{p.label}</span>
                          <span className="font-medium tabular-nums">{fmt(p.total)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Categories + Recent orders */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-1">
              <CardHeader>
                <CardTitle>{t('dashboard.topCategories')}</CardTitle>
                <CardDescription>30d</CardDescription>
              </CardHeader>
              <CardContent>
                {categoryData.length === 0 ? (
                  <EmptyChart label={t('dashboard.noSalesYet')} />
                ) : (
                  <ChartContainer config={categoryConfig} className="h-[220px] w-full">
                    <BarChart data={categoryData} layout="vertical" margin={{ left: 4, right: 12 }}>
                      <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                      <XAxis type="number" hide />
                      <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={80} tick={{ fontSize: 12 }} />
                      <ChartTooltip content={<ChartTooltipContent hideLabel formatter={(val) => fmt(Number(val))} />} />
                      <Bar dataKey="revenue" fill="var(--chart-1)" radius={[0, 6, 6, 0]} barSize={22} />
                    </BarChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader className="flex flex-row items-center justify-between">
                <div className="space-y-1.5">
                  <CardTitle>{t('dashboard.recentOrders')}</CardTitle>
                  <CardDescription>{t('dashboard.title')}</CardDescription>
                </div>
                <Link href="/orders" className="flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                  {t('dashboard.viewAll')} <ArrowRight className="size-3.5" />
                </Link>
              </CardHeader>
              <CardContent className="px-2">
                {recentOrders.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">{t('dashboard.noOrdersYet')}</p>
                ) : (
                  <div>
                    {recentOrders.map((o, i) => (
                      <div key={o.id}>
                        {i > 0 && <Separator />}
                        <Link href="/orders" className="flex items-center justify-between gap-3 rounded-md px-4 py-2.5 transition-colors hover:bg-muted/60">
                          <div className="flex items-center gap-3">
                            <Avatar className="size-9 rounded-lg">
                              <AvatarFallback className="rounded-lg bg-muted text-xs font-medium">#{o.order_number.slice(-2)}</AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="text-sm font-medium">#{o.order_number}</p>
                              <p className="text-xs text-muted-foreground">{o.customer_name || o.table_name || t('dashboard.walkIn')}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <Badge variant={orderStatusVariant[o.status] ?? 'outline'} className="capitalize">
                              {t(`orders.${o.status}` as 'orders.pending')}
                            </Badge>
                            <span className="w-16 text-right text-sm font-semibold tabular-nums">{fmt(Number(o.total))}</span>
                          </div>
                        </Link>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Products + staff */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingUp className="size-4 text-muted-foreground" />
                  <CardTitle>{t('dashboard.topProductsToday')}</CardTitle>
                </div>
                <Link href="/products" className="flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                  {t('dashboard.viewAll')} <ArrowRight className="size-3.5" />
                </Link>
              </CardHeader>
              <CardContent className="space-y-4">
                {topProducts.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">{t('dashboard.noSalesYet')}</p>
                ) : topProducts.map((p, i) => (
                  <div key={p.product_id} className="space-y-1.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2">
                        <span className="grid size-5 place-items-center rounded bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground">{i + 1}</span>
                        <span className="font-medium">{p.product_name}</span>
                      </span>
                      <span className="font-semibold tabular-nums">{fmt(Number(p.total_revenue))}</span>
                    </div>
                    <Progress value={(Number(p.total_revenue) / productMax) * 100} className="h-1.5" />
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div className="flex items-center gap-2">
                  <Trophy className="size-4 text-muted-foreground" />
                  <CardTitle>{t('dashboard.topStaff')}</CardTitle>
                </div>
                <Link href="/staff" className="flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                  {t('dashboard.viewAll')} <ArrowRight className="size-3.5" />
                </Link>
              </CardHeader>
              <CardContent className="space-y-4">
                {(insights?.topStaff.length ?? 0) === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">{t('dashboard.noSalesYet')}</p>
                ) : insights!.topStaff.map((s) => (
                  <div key={s.user_id} className="flex items-center gap-3">
                    <Avatar className="size-9">
                      <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                        {s.name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium">{s.name}</span>
                        <span className="font-semibold tabular-nums">{fmt(Number(s.revenue))}</span>
                      </div>
                      <Progress value={(Number(s.revenue) / staffMax) * 100} className="h-1.5" />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
      <div className="flex flex-col items-center gap-2">
        <TrendingDown className="size-6 opacity-40" />
        {label}
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Skeleton className="h-80 rounded-xl lg:col-span-2" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
