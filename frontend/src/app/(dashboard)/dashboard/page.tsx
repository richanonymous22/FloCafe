'use client';

import { useState, useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import { cn } from '@/lib/utils';
import { Banknote, ChefHat, Clock, LayoutGrid, TrendingUp, ClipboardList, ArrowRight, Timer, Trophy, Tags, BarChart3, Wallet } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import toast from 'react-hot-toast';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { getCountryByCode } from '@/lib/countries';
import { PAYMENT_METHODS } from '@/lib/payment-methods';
import { PageHeader, PageContainer } from '@/components/ui/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { EmptyState } from '@/components/ui/empty-state';

interface PaymentMethodBreakdown {
  method: string | null;
  count: number;
  total: number;
}

interface DailyStats {
  sales: number;
  runningOrders: number;
  pendingOrders: number;
  tablesOccupied: number;
  paymentMethods: PaymentMethodBreakdown[];
}

interface DaySummary {
  date: string;
  orders: { count: number; total: number };
  bills: { count: number; total: number; collected: number };
  customers: { new: number };
  paymentMethods: PaymentMethodBreakdown[];
}

interface TopProduct {
  product_id: number;
  product_name: string;
  total_quantity: number;
  total_revenue: number;
  order_count: number;
}

interface RecentOrder {
  id: number;
  order_number: string;
  status: string;
  total: number;
  customer_name: string | null;
  table_name: string | null;
  created_at: string;
}

interface TopStaff {
  user_id: string;
  name: string;
  role: string;
  revenue: number;
  orderCount: number;
}

interface TopCategory {
  category_id: string | null;
  name: string;
  quantity: number;
  revenue: number;
}

interface HourBucket {
  hour: number;
  orderCount: number;
}

interface DayBucket {
  dayIndex: number;
  orderCount: number;
}

interface Insights {
  windowDays: number;
  aov: number;
  avgPrepTimeMinutes: number | null;
  topStaff: TopStaff[];
  topCategories: TopCategory[];
  busiestHour: HourBucket | null;
  idlestHour: HourBucket | null;
  busiestDayOfWeek: DayBucket | null;
  idlestDayOfWeek: DayBucket | null;
}

/** Today's date as YYYY-MM-DD in a given IANA timezone (not UTC — avoids an
 *  off-by-one-day default near midnight relative to the tenant's locale). */
function getLocalDateString(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD by convention — a convenient built-in shortcut.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Formats a 0-23 local hour index as a locale-appropriate time label (e.g. "2 PM"). */
function formatHourLabel(hour: number, locale: string): string {
  const reference = new Date(Date.UTC(2000, 0, 1, hour));
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: 'UTC' }).format(reference);
}

/** Formats a 0=Sunday..6=Saturday index as a locale-appropriate weekday name. */
function formatWeekdayLabel(dayIndex: number, locale: string): string {
  // Jan 2, 2000 was a Sunday — using local-time Date math (no timeZone
  // needed here, the hour/day bucketing already resolved to the tenant's
  // local calendar server-side).
  const reference = new Date(2000, 0, 2 + dayIndex);
  return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(reference);
}

const orderStatusTone: Record<string, 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info'> = {
  pending: 'warning',
  preparing: 'info',
  ready: 'success',
  served: 'brand',
  completed: 'neutral',
  cancelled: 'danger',
};

function localizeTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? `{${k}}`));
}

export default function DashboardPage() {
  const { currentTenant } = useAuthStore();
  const { t } = useI18n();
  const router = useRouter();
  const [stats, setStats] = useState<DailyStats | null>(null);
  const [daySummary, setDaySummary] = useState<DaySummary | null>(null);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);

  const isOwner = currentTenant?.role === 'owner';
  const fmt = useFormatCurrency();
  const locale = currentTenant?.country ? (getCountryByCode(currentTenant.country)?.locale ?? 'en-US') : 'en-US';
  const timeZone = currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayLocal = getLocalDateString(new Date(), timeZone);
  const [selectedDate, setSelectedDate] = useState(todayLocal);
  const isToday = selectedDate === todayLocal;

  useEffect(() => {
    if (currentTenant && !isOwner) {
      router.replace('/pos');
    }
  }, [currentTenant, isOwner, router]);

  // Show the spinner again as soon as isOwner/selectedDate change, read directly during
  // render (React's recommended pattern for "adjusting state when a prop changes") so the
  // effect below only needs to own the async fetch and its own completion state.
  const syncKey = `${isOwner}:${selectedDate}`;
  const [syncedKey, setSyncedKey] = useState(syncKey);
  if (syncKey !== syncedKey) {
    setSyncedKey(syncKey);
    if (isOwner) setLoading(true);
  }

  useEffect(() => {
    if (!isOwner) return;
    const controller = new AbortController();
    Promise.all([
      isToday ? api.get('/reports/daily-stats', { signal: controller.signal }) : api.get('/reports/summary', { params: { date: selectedDate }, signal: controller.signal }),
      api.get('/reports/topProducts', { params: { start_date: selectedDate, end_date: selectedDate, limit: 5 }, signal: controller.signal }),
      api.get('/reports/recentOrders', { params: { date: selectedDate, limit: 6 }, signal: controller.signal }),
      api.get('/reports/insights', { params: { days: 30 }, signal: controller.signal }),
    ])
      .then(([statsRes, topRes, recentRes, insightsRes]) => {
        setStats(isToday ? statsRes.data : null);
        setDaySummary(isToday ? null : statsRes.data.summary);
        setTopProducts(topRes.data.topProducts || []);
        setRecentOrders(recentRes.data.recentOrders || []);
        setInsights(insightsRes.data);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) return;
        toast.error(t('common.somethingWrong'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner, selectedDate]);

  if (!isOwner) return null;

  const paymentMethods = isToday ? (stats?.paymentMethods ?? []) : (daySummary?.paymentMethods ?? []);
  const paymentMethodsTotal = paymentMethods.reduce((sum, pm) => sum + Number(pm.total), 0);

  // Running/Pending Orders and Tables Occupied are live, "right now" concepts
  // that don't retroactively apply to a past date (an order isn't "pending"
  // in history — it has a final status). When viewing a past date, swap them
  // for the day's actual totals from /reports/summary instead.
  const dateScopedTiles = isToday
    ? [
        { label: t('dashboard.runningOrders'), value: stats?.runningOrders ?? 0, icon: ChefHat, href: '/orders' },
        { label: t('dashboard.pendingOrders'), value: stats?.pendingOrders ?? 0, icon: Clock, href: '/orders' },
        { label: t('dashboard.tablesOccupied'), value: stats?.tablesOccupied ?? 0, icon: LayoutGrid, href: '/tables' },
      ]
    : [
        { label: t('dashboard.orders'), value: daySummary?.orders.count ?? 0, icon: ChefHat, href: '/orders' },
        { label: t('dashboard.newCustomers'), value: daySummary?.customers.new ?? 0, icon: Clock, href: '/customers' },
      ];

  const tiles: { label: string; value: ReactNode; icon: typeof Banknote; href: string; primary?: boolean }[] = [
    {
      label: isToday ? t('dashboard.todaySales') : t('dashboard.sales'),
      value: fmt(isToday ? (stats?.sales ?? 0) : (daySummary?.bills.collected ?? 0)),
      icon: Banknote,
      href: '/orders',
      primary: true,
    },
    ...dateScopedTiles,
    {
      label: t('dashboard.aov'),
      value: fmt(insights?.aov ?? 0),
      icon: TrendingUp,
      href: '/orders',
    },
    {
      label: t('dashboard.avgPrepTime'),
      value: insights?.avgPrepTimeMinutes != null ? localizeTemplate(t('dashboard.minutesValue'), { minutes: insights.avgPrepTimeMinutes }) : '—',
      icon: Timer,
      href: '/orders',
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow={isToday ? t('dashboard.overview') : selectedDate}
        title={t('dashboard.title')}
        description={currentTenant?.business_name}
        actions={
          <input
            type="date"
            value={selectedDate}
            max={todayLocal}
            onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
            className="h-10 rounded-lg border border-input bg-surface px-3.5 text-sm text-foreground shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            aria-label={t('dashboard.selectDate')}
          />
        }
      />

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <div className="size-8 animate-spin rounded-full border-[3px] border-primary border-t-transparent" />
        </div>
      ) : (
        <div className="animate-rise space-y-8">
          {/* ── KPI band ─────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {tiles.map((tile) => (
              <Link
                key={tile.label}
                href={tile.href}
                className={cn(
                  'group flex flex-col justify-between rounded-2xl border p-4 shadow-xs transition-all hover:-translate-y-0.5 hover:shadow-md',
                  tile.primary
                    ? 'border-transparent bg-primary text-primary-foreground'
                    : 'border-hairline bg-surface'
                )}
              >
                <div className="mb-4 flex items-center justify-between">
                  <span className={cn('eyebrow', tile.primary && 'text-primary-foreground/70')}>
                    {tile.label}
                  </span>
                  <tile.icon className={cn('size-4', tile.primary ? 'text-primary-foreground/70' : 'text-muted-foreground/60')} />
                </div>
                <p className={cn('figure text-3xl', tile.primary ? 'text-primary-foreground' : 'text-foreground')}>
                  {tile.value}
                </p>
              </Link>
            ))}
          </div>

          {/* ── Orders + Top products ────────────────────────────── */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Panel
              icon={<ClipboardList className="size-4" />}
              title={isToday ? t('dashboard.recentOrders') : t('dashboard.orders')}
              action={<ViewAll href="/orders" label={t('dashboard.viewAll')} />}
            >
              {recentOrders.length === 0 ? (
                <EmptyState compact icon={<ClipboardList className="size-5" />} title={t('dashboard.noOrdersYet')} />
              ) : (
                <ul className="divide-y divide-hairline">
                  {recentOrders.map((order) => (
                    <li key={order.id}>
                      <Link href="/orders" className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-surface-sunken">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-foreground">#{order.order_number}</span>
                            <StatusPill size="sm" tone={orderStatusTone[order.status] ?? 'neutral'}>
                              {t(`orders.${order.status}` as 'orders.pending' | 'orders.preparing' | 'orders.ready' | 'orders.served' | 'orders.completed' | 'orders.cancelled')}
                            </StatusPill>
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {order.customer_name || order.table_name || t('dashboard.walkIn')}
                          </p>
                        </div>
                        <span className="figure shrink-0 text-base text-foreground">{fmt(Number(order.total))}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              icon={<TrendingUp className="size-4" />}
              title={t('dashboard.topProductsToday')}
              action={<ViewAll href="/products" label={t('dashboard.viewAll')} />}
            >
              {topProducts.length === 0 ? (
                <EmptyState compact icon={<TrendingUp className="size-5" />} title={t('dashboard.noSalesYet')} />
              ) : (
                <ol className="divide-y divide-hairline">
                  {topProducts.map((product, i) => (
                    <li key={product.product_id} className="flex items-center justify-between gap-3 px-5 py-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="figure w-5 shrink-0 text-center text-sm text-muted-foreground">{i + 1}</span>
                        <div className="min-w-0">
                          <span className="font-medium text-foreground">{product.product_name}</span>
                          <p className="text-xs text-muted-foreground">{localizeTemplate(t('dashboard.productSoldOrders'), { quantity: product.total_quantity, orders: product.order_count })}</p>
                        </div>
                      </div>
                      <span className="figure shrink-0 text-base text-foreground">{fmt(Number(product.total_revenue))}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
          </div>

          {/* ── Staff + Categories ───────────────────────────────── */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Panel
              icon={<Trophy className="size-4" />}
              title={t('dashboard.topStaff')}
              action={<ViewAll href="/staff" label={t('dashboard.viewAll')} />}
            >
              {(insights?.topStaff.length ?? 0) === 0 ? (
                <EmptyState compact icon={<Trophy className="size-5" />} title={t('dashboard.noSalesYet')} />
              ) : (
                <ul className="divide-y divide-hairline">
                  {insights!.topStaff.map((staff) => (
                    <li key={staff.user_id} className="flex items-center justify-between gap-3 px-5 py-3">
                      <div className="min-w-0">
                        <span className="font-medium text-foreground">{staff.name}</span>
                        <p className="text-xs text-muted-foreground">{localizeTemplate(t('dashboard.staffOrderCount'), { orders: staff.orderCount })}</p>
                      </div>
                      <span className="figure shrink-0 text-base text-foreground">{fmt(Number(staff.revenue))}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel icon={<Tags className="size-4" />} title={t('dashboard.topCategories')}>
              {(insights?.topCategories.length ?? 0) === 0 ? (
                <EmptyState compact icon={<Tags className="size-5" />} title={t('dashboard.noSalesYet')} />
              ) : (
                <ul className="divide-y divide-hairline">
                  {insights!.topCategories.map((category) => (
                    <li key={category.category_id ?? category.name} className="flex items-center justify-between gap-3 px-5 py-3">
                      <div className="min-w-0">
                        <span className="font-medium text-foreground">{category.name}</span>
                        <p className="text-xs text-muted-foreground">{localizeTemplate(t('dashboard.categoryQuantitySold'), { quantity: category.quantity })}</p>
                      </div>
                      <span className="figure shrink-0 text-base text-foreground">{fmt(Number(category.revenue))}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          {/* ── Payment methods ──────────────────────────────────── */}
          <Panel icon={<Wallet className="size-4" />} title={t('dashboard.paymentMethods')} bodyClassName="p-5">
            {paymentMethods.length === 0 ? (
              <EmptyState compact icon={<Wallet className="size-5" />} title={t('dashboard.noPaymentsYet')} />
            ) : (
              <div className="space-y-4">
                {paymentMethods.map((pm) => {
                  const meta = PAYMENT_METHODS.find((m) => m.key === pm.method);
                  const Icon = meta?.icon ?? Wallet;
                  const label = meta ? t(meta.labelKey) : pm.method === 'wallet' ? t('pos.methodWallet') : String(pm.method || t('common.unknown'));
                  const percent = paymentMethodsTotal > 0 ? Math.round((Number(pm.total) / paymentMethodsTotal) * 100) : 0;
                  return (
                    <div key={pm.method ?? 'unknown'}>
                      <div className="mb-1.5 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Icon size={14} className="text-muted-foreground" />
                          <span className="text-sm font-medium text-foreground">{label}</span>
                        </div>
                        <span className="figure text-sm text-foreground">{fmt(Number(pm.total))}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
                        </div>
                        <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {localizeTemplate(t('dashboard.paymentMethodCount'), { count: pm.count, percent })}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          {/* ── Business patterns ────────────────────────────────── */}
          <Panel
            icon={<BarChart3 className="size-4" />}
            title={t('dashboard.businessPatterns')}
            subtitle={localizeTemplate(t('dashboard.businessPatternsHint'), { days: insights?.windowDays ?? 30 })}
            bodyClassName="p-5"
          >
            <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
              <Pattern label={t('dashboard.busiestHour')} value={insights?.busiestHour ? formatHourLabel(insights.busiestHour.hour, locale) : t('dashboard.notEnoughData')} note={insights?.busiestHour ? localizeTemplate(t('dashboard.ordersCount'), { count: insights.busiestHour.orderCount }) : undefined} />
              <Pattern label={t('dashboard.idlestHour')} value={insights?.idlestHour ? formatHourLabel(insights.idlestHour.hour, locale) : t('dashboard.notEnoughData')} note={insights?.idlestHour ? localizeTemplate(t('dashboard.ordersCount'), { count: insights.idlestHour.orderCount }) : undefined} />
              <Pattern label={t('dashboard.busiestDay')} value={insights?.busiestDayOfWeek ? formatWeekdayLabel(insights.busiestDayOfWeek.dayIndex, locale) : t('dashboard.notEnoughData')} note={insights?.busiestDayOfWeek ? localizeTemplate(t('dashboard.ordersCount'), { count: insights.busiestDayOfWeek.orderCount }) : undefined} />
              <Pattern label={t('dashboard.idlestDay')} value={insights?.idlestDayOfWeek ? formatWeekdayLabel(insights.idlestDayOfWeek.dayIndex, locale) : t('dashboard.notEnoughData')} note={insights?.idlestDayOfWeek ? localizeTemplate(t('dashboard.ordersCount'), { count: insights.idlestDayOfWeek.orderCount }) : undefined} />
            </div>
          </Panel>
        </div>
      )}
    </PageContainer>
  );
}

/** Editorial content panel — small-caps titled section with soft depth. */
function Panel({
  icon,
  title,
  subtitle,
  action,
  bodyClassName,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-4">
        <div className="flex items-center gap-2.5">
          {icon && <span className="text-muted-foreground">{icon}</span>}
          <div>
            <h2 className="eyebrow">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {action}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

function ViewAll({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-brand-strong">
      {label} <ArrowRight className="size-3" />
    </Link>
  );
}

function Pattern({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <p className="eyebrow mb-1.5">{label}</p>
      <p className="text-display text-xl text-foreground">{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
