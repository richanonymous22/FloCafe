'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';


import toast from 'react-hot-toast';
import { Plus, Search, X, Edit, Wallet, History, TrendingUp, TrendingDown, AlertCircle } from 'lucide-react';
import { useSearchParams, useRouter } from 'next/navigation';
import { parseDbTimestamp } from '@/lib/utils';

import type { Customer } from '@/lib/types';
import { countryName } from '@/lib/countries';
import { dialCodeFor, parsePhone } from '@/lib/phone';
import { useI18n } from '@/hooks/useI18n';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { nameToColor } from '@/lib/image-utils';

function SortIcon({ field, sortField, sortOrder }: { field: string; sortField: string; sortOrder: 'asc' | 'desc' }) {
  if (sortField !== field) return <span className="text-text-subtle w-3 inline-block ml-1 opacity-0 group-hover:opacity-100 transition-opacity">↕</span>;
  return sortOrder === 'asc' ? <TrendingUp size={12} className="inline ml-1 text-muted-foreground" /> : <TrendingDown size={12} className="inline ml-1 text-muted-foreground" />;
}

function KpiCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-4 shadow-xs">
      <p className="text-[11px] font-bold uppercase tracking-wide text-text-subtle">{label}</p>
      <p className="mt-1.5 text-2xl font-bold tracking-tight text-foreground">{value}</p>
      <p className="mt-0.5 text-xs text-text-subtle">{sub}</p>
    </div>
  );
}

export default function CustomersPage() {
  const { currentTenant } = useAuthStore();
  const { t } = useI18n();
  const fmt = useFormatCurrency();
  const defaultCountry = currentTenant?.country || 'IN';
  const dialCode = dialCodeFor(defaultCountry) || '+91';
  const searchParams = useSearchParams();
  const router = useRouter();
  const filter = searchParams.get('filter');
  
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState('name');
  const [sortOrder, setSortOrder] = useState<'asc'|'desc'>('asc');
  const [showForm, setShowForm] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);

  const [form, setForm] = useState({ name: '', phone: '', email: '', country_code: dialCode });

  const [ledgerCustomer, setLedgerCustomer] = useState<Customer | null>(null);
  const [ledgerData, setLedgerData] = useState<{ balance: number; transactions: { id: number; type: string; amount: number; description: string; created_at: string; expires_at?: string }[] } | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);

  const openLedger = async (c: Customer) => {
    setLedgerCustomer(c);
    setLedgerData(null);
    setLedgerLoading(true);
    try {
      const { data } = await api.get(`/customers/${c.id}/wallet`);
      setLedgerData(data);
    } catch {
      toast.error(t('customer.ledgerLoadFailed'));
    } finally {
      setLedgerLoading(false);
    }
  };

  const fmtDate = (d: string) => {
    try { return parseDbTimestamp(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch { return d; }
  };

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
    const params: Record<string, string> = {};
    if (search) params.search = search;
    if (filter) params.filter = filter;
    if (sortField) params.sort = sortField;
    if (sortOrder) params.order = sortOrder;
    api.get('/customers', { params, signal: controller.signal })
      .then(({ data }) => setCustomers(data.data || []))
      .catch((err: unknown) => {
        if (!(err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))) toast.error(t('customer.loadFailed'));
      })
      .finally(() => { setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filter, sortField, sortOrder, refreshKey]);

  const openAdd = () => {
    setEditingCustomer(null);

    setForm({ name: '', phone: '', email: '', country_code: dialCode });
    setShowForm(true);
  };

  const openEdit = (c: Customer) => {
    setEditingCustomer(c);

    setForm({ name: c.name, phone: c.phone || '', email: c.email || '', country_code: c.country_code || dialCode });
    setShowForm(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parsePhone(form.phone, defaultCountry);
    if (!parsed) {
      toast.error(t('pos.invalidPhone', { country: countryName(defaultCountry) }));
      return;
    }
    const payload = { ...form, phone: parsed.e164, country_code: parsed.countryCode };
    try {
      if (editingCustomer) {
        await api.put(`/customers/${editingCustomer.id}`, payload);
        toast.success(t('customer.updated'));
      } else {
        await api.post('/customers', payload);
        toast.success(t('customer.added'));
      }
      setShowForm(false);
      setRefreshKey((k) => k + 1);
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      toast.error(error.response?.data?.error || t('customer.saveFailed'));
    }
  };

  const onSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder(field === 'name' ? 'asc' : 'desc');
    }
  };

  const loyaltyMembers = customers.filter((c) => Number(c.wallet_balance) > 0).length;
  const pointsOutstanding = customers.reduce((s, c) => s + Number(c.wallet_balance || 0), 0);
  const lifetimeSpend = customers.reduce((s, c) => s + Number(c.total_spent || 0), 0);

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{t('nav.customers')}</h1>
            {filter === 'invalid_phones' && (
              <span className="bg-danger-tint text-danger text-xs px-2.5 py-1 rounded-full font-semibold flex items-center gap-1.5">
                <AlertCircle size={14} /> Action Required
                <button onClick={() => router.push('/customers')} className="ml-1 opacity-70 hover:opacity-100">
                  <X size={12} />
                </button>
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-text-subtle">Your guest book — visits, spend and loyalty in one place.</p>
        </div>
        <Button onClick={openAdd} className="h-10 gap-2 rounded-xl font-semibold shadow-sm"><Plus size={16} /> {t('customer.add')}</Button>
      </div>

      {/* KPI band */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Customers" value={String(customers.length)} sub={search || filter ? 'in this view' : 'in your guest book'} />
        <KpiCard label="Loyalty members" value={String(loyaltyMembers)} sub="with a points balance" />
        <KpiCard label="Points outstanding" value={pointsOutstanding.toLocaleString()} sub="across all wallets" />
        <KpiCard label="Lifetime spend" value={fmt(lifetimeSpend)} sub="total recorded" />
      </div>

      <div className="relative">
        <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
        <input
          type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder={t('customer.search')}
          className="h-11 w-full rounded-xl bg-surface border border-hairline pl-10 pr-4 text-sm outline-none transition-colors placeholder:text-text-subtle focus:border-input"
        />
      </div>

      <div className="bg-surface rounded-2xl border border-hairline overflow-hidden shadow-sm">
        <table className="w-full">
          <thead className="border-b border-hairline bg-surface-sunken">
            <tr className="[&>th]:p-4 [&>th]:text-[11px] [&>th]:font-bold [&>th]:uppercase [&>th]:tracking-wide [&>th]:text-text-subtle">
              <th className="text-left cursor-pointer hover:text-foreground group transition-colors" onClick={() => onSort('name')}>
                {t('customers.columnCustomer')} <SortIcon field="name" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th className="text-left cursor-pointer hover:text-foreground group transition-colors" onClick={() => onSort('phone')}>
                {t('customer.phone')} <SortIcon field="phone" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th className="text-center cursor-pointer hover:text-foreground group transition-colors" onClick={() => onSort('last_visit')}>
                Last Visit <SortIcon field="last_visit" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th className="text-center cursor-pointer hover:text-foreground group transition-colors" onClick={() => onSort('visits')}>
                {t('customer.visits')} <SortIcon field="visits" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th className="text-right cursor-pointer hover:text-foreground group transition-colors" onClick={() => onSort('spent')}>
                {t('customer.totalSpent')} <SortIcon field="spent" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th className="text-right cursor-pointer hover:text-foreground group transition-colors" onClick={() => onSort('loyalty')}>
                {t('customer.loyalty')} <SortIcon field="loyalty" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th className="text-center">{t('customers.columnActions')}</th>
              <th className="text-center">{t('customers.columnLedger')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {customers.map((c) => (
              <tr key={c.id} className="hover:bg-surface-sunken">
                <td className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: nameToColor(c.name) }}>
                      <span className="text-sm font-bold text-white/80">{c.name.substring(0, 2).toUpperCase()}</span>
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">{c.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{c.email || '—'}</p>
                    </div>
                  </div>
                </td>
                <td className="p-4 text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span>
                      {c.phone ? (c.country_code && !c.phone.startsWith(c.country_code) ? `${c.country_code}${c.phone}` : c.phone) : '—'}
                    </span>
                    {c.phone && !c.phone.startsWith('+') && (
                      <div className="text-red-500 flex items-center" title="Invalid format">
                        <AlertCircle size={16} />
                      </div>
                    )}
                  </div>
                </td>
                <td className="p-4 text-center text-sm text-muted-foreground whitespace-nowrap">
                  {c.last_visit_at ? fmtDate(c.last_visit_at) : '—'}
                </td>
                <td className="p-4 text-center text-sm">{c.visits_count}</td>
                <td className="p-4 text-right font-medium">{fmt(Number(c.total_spent))}</td>
                <td className="p-4 text-right">
                  {Number(c.wallet_balance) > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-warning-tint px-2.5 py-0.5 text-xs font-semibold text-warning">
                      <Wallet size={12} />
                      {Number(c.wallet_balance).toLocaleString()} {t('customer.ptsSuffix')}
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </td>
                <td className="p-4 text-center">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(c)}>
                    <Edit size={14} />
                  </Button>
                </td>
                <td className="p-4 text-center">
                  <Button variant="ghost" size="sm" onClick={() => openLedger(c)} title={t('customer.viewLedgerTitle')}>
                    <History size={14} />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {customers.length === 0 && <p className="text-center text-muted-foreground py-12">{t('customers.empty')}</p>}
        {customers.length >= 200 && <p className="text-center text-xs text-muted-foreground py-3">{t('customers.first200')}</p>}
      </div>

      {/* Loyalty Ledger Modal */}
      {ledgerCustomer && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-surface rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-xl">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-hairline">
              <div>
                <h2 className="text-lg font-bold text-foreground">{t('customers.loyaltyLedger')}</h2>
                <p className="text-sm text-muted-foreground">{ledgerCustomer.name}</p>
              </div>
              <button onClick={() => setLedgerCustomer(null)} className="w-8 h-8 flex items-center justify-center rounded-full bg-secondary hover:bg-secondary">
                <X size={16} className="text-muted-foreground" />
              </button>
            </div>

            {ledgerLoading ? (
              <div className="flex-1 flex items-center justify-center py-12 text-muted-foreground">{t('customer.loadingLedger')}</div>
            ) : ledgerData ? (
              <>
                {/* Summary row */}
                <div className="flex items-center gap-6 px-6 py-4 bg-surface-sunken border-b border-hairline">
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">{t('customers.totalBalance')}</p>
                    <p className="text-display-lg text-3xl text-foreground">{ledgerData.balance} <span className="text-sm font-normal text-muted-foreground">{t('customer.ptsSuffix')}</span></p>
                  </div>
                </div>

                {/* Ledger table */}
                <div className="flex-1 overflow-y-auto">
                  {ledgerData.transactions.length === 0 ? (
                    <p className="text-center text-muted-foreground py-12">{t('customers.noTransactions')}</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="bg-surface-sunken sticky top-0">
                        <tr>
                          <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">{t('customers.columnDate')}</th>
                          <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">{t('customers.columnDescription')}</th>
                          <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">{t('customers.columnPoints')}</th>
                          <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">{t('customers.columnExpires')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-hairline">
                        {ledgerData.transactions.map((t: { id: number; type: string; amount: number; description: string; created_at: string; expires_at?: string }) => (
                          <tr key={t.id} className="hover:bg-surface-sunken">
                            <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmtDate(t.created_at)}</td>
                            <td className="px-4 py-3 text-foreground">{t.description || '—'}</td>
                            <td className="px-4 py-3 text-right font-semibold whitespace-nowrap">
                              <span className={`inline-flex items-center gap-1 ${
                                t.type === 'credit' ? 'text-green-600' : 'text-red-500'
                              }`}>
                                {t.type === 'credit'
                                  ? <TrendingUp size={12} />
                                  : <TrendingDown size={12} />}
                                {t.type === 'credit' ? '+' : '-'}{t.amount}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right text-xs text-muted-foreground whitespace-nowrap">
                              {t.expires_at ? fmtDate(t.expires_at) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{editingCustomer ? t('customer.edit') : t('customer.add')}</h2>
              <button onClick={() => setShowForm(false)}><X size={20} className="text-muted-foreground" /></button>
            </div>
            <form onSubmit={handleSave} className="space-y-4">
              <input type="text" placeholder={t('customer.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required />
              <div className="flex items-stretch gap-2">
                <input type="tel" placeholder={dialCode ? `${dialCode} ${t('customer.phone')}` : t('customer.phone')} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="flex-1 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required />
              </div>
              <input type="email" placeholder={`${t('customer.email')} (${t('common.optional')})`} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
              <Button type="submit" className="w-full">{editingCustomer ? t('customer.update') : t('customer.add')}</Button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
