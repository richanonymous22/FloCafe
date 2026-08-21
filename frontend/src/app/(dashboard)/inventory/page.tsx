'use client';

/**
 * Inventory management (Milestone 4, Part U) — Serva-styled rebuild.
 *
 * A touch-friendly stock view: see what's low or out, look up any tracked
 * product's balance and movement history, and record a manual adjustment.
 * No purchasing, suppliers, transfers, or forecasting — see
 * docs/MILESTONE_4_INVENTORY.md for what's intentionally deferred.
 */

import { useEffect, useMemo, useState } from 'react';
import { Search, Boxes, TriangleAlert, History, X, PackageSearch, PackageX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { nameToColor } from '@/lib/image-utils';
import { parseDbTimestamp } from '@/lib/utils';
import api from '@/lib/api';

interface Product {
  id: string;
  name: string;
  sku?: string | null;
  price?: number;
  track_inventory: number | boolean;
  stock_quantity: number;
  low_stock_threshold: number;
}

interface Variant {
  id: string;
  name: string | null;
  sku: string | null;
}

interface Movement {
  id: string;
  movement_type: string;
  quantity_delta: number;
  balance_after: number;
  reason: string | null;
  created_at: string;
}

type StockState = 'in' | 'low' | 'out';

function errorMessage(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return message || fallback;
}

function stockState(qty: number, threshold: number): StockState {
  if (qty <= 0) return 'out';
  if (qty <= (threshold || 0)) return 'low';
  return 'in';
}

const STATE_META: Record<StockState, { label: string; cls: string }> = {
  in: { label: 'In stock', cls: 'bg-success-tint text-success' },
  low: { label: 'Low', cls: 'bg-warning-tint text-warning' },
  out: { label: 'Out of stock', cls: 'bg-danger-tint text-danger' },
};

function KpiCard({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-4 shadow-xs">
      <p className="text-[11px] font-bold uppercase tracking-wide text-text-subtle">{label}</p>
      <p className={`mt-1.5 text-2xl font-bold tracking-tight ${tone || 'text-foreground'}`}>{value}</p>
      <p className="mt-0.5 text-xs text-text-subtle">{sub}</p>
    </div>
  );
}

export default function InventoryPage() {
  const fmt = useFormatCurrency();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | StockState>('all');

  // Detail drawer
  const [selected, setSelected] = useState<Product | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [selectedVariant, setSelectedVariant] = useState<Variant | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [history, setHistory] = useState<Movement[]>([]);
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadProducts() {
    try {
      const res = await api.get('/products', { params: { active: 'true' } });
      const list: Product[] = res.data.products || res.data || [];
      setProducts(list.filter((p) => p.track_inventory));
    } catch { /* best-effort */ } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    api.get('/products', { params: { active: 'true' } })
      .then((res) => {
        const list: Product[] = res.data.products || res.data || [];
        setProducts(list.filter((p) => p.track_inventory));
      })
      .catch(() => { /* best-effort */ })
      .finally(() => setLoading(false));
  }, []);

  const tracked = products.length;
  const lowCount = products.filter((p) => stockState(p.stock_quantity, p.low_stock_threshold) === 'low').length;
  const outCount = products.filter((p) => stockState(p.stock_quantity, p.low_stock_threshold) === 'out').length;
  const stockValue = products.reduce((s, p) => s + Number(p.price || 0) * Math.max(0, p.stock_quantity || 0), 0);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products
      .filter((p) => {
        if (filter !== 'all' && stockState(p.stock_quantity, p.low_stock_threshold) !== filter) return false;
        if (!q) return true;
        return p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const order: Record<StockState, number> = { out: 0, low: 1, in: 2 };
        return order[stockState(a.stock_quantity, a.low_stock_threshold)] - order[stockState(b.stock_quantity, b.low_stock_threshold)];
      });
  }, [products, query, filter]);

  async function openDetail(product: Product) {
    setSelected(product);
    setSelectedVariant(null);
    setError(null);
    setAdjustQty('');
    setAdjustReason('');
    try {
      const res = await api.get('/retail/variants', { params: { product_id: product.id } });
      setVariants(res.data.variants || []);
    } catch { setVariants([]); }
    await loadBalanceAndHistory(product.id, null);
  }

  function closeDetail() {
    setSelected(null);
    setVariants([]);
    setHistory([]);
    setBalance(null);
  }

  async function selectVariant(variant: Variant | null) {
    setSelectedVariant(variant);
    if (selected) await loadBalanceAndHistory(selected.id, variant?.id ?? null);
  }

  async function loadBalanceAndHistory(productId: string, variantId: string | null) {
    try {
      const [balanceRes, historyRes] = await Promise.all([
        api.get('/inventory/balance', { params: { product_id: productId, variant_id: variantId || undefined } }),
        api.get('/inventory/history', { params: { product_id: productId, variant_id: variantId || undefined, limit: 20 } }),
      ]);
      setBalance(balanceRes.data.balance);
      setHistory(historyRes.data.movements);
    } catch (err) {
      setError(errorMessage(err, 'Could not load stock data'));
    }
  }

  async function submitAdjustment() {
    if (!selected || !adjustQty || !adjustReason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/inventory/adjust', {
        product_id: selected.id,
        variant_id: selectedVariant?.id ?? null,
        quantity_delta: Number(adjustQty),
        reason: adjustReason.trim(),
      });
      setAdjustQty('');
      setAdjustReason('');
      await loadBalanceAndHistory(selected.id, selectedVariant?.id ?? null);
      await loadProducts();
    } catch (err) {
      setError(errorMessage(err, 'Adjustment failed'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="size-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
      </div>
    );
  }

  const FILTERS: { key: 'all' | StockState; label: string; count: number }[] = [
    { key: 'all', label: 'All tracked', count: tracked },
    { key: 'low', label: 'Low', count: lowCount },
    { key: 'out', label: 'Out of stock', count: outCount },
  ];

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5">
      {/* Masthead */}
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Inventory</h1>
        <p className="text-sm text-text-subtle">Track stock levels, spot what&apos;s low, and record adjustments.</p>
      </div>

      {/* KPI band */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Tracked items" value={String(tracked)} sub="with stock control on" />
        <KpiCard label="Low stock" value={String(lowCount)} sub="at or below threshold" tone={lowCount ? 'text-warning' : undefined} />
        <KpiCard label="Out of stock" value={String(outCount)} sub="need reordering" tone={outCount ? 'text-danger' : undefined} />
        <KpiCard label="Stock value" value={fmt(stockValue)} sub="at retail price" />
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex items-center gap-1 rounded-xl border border-hairline bg-surface p-1 shadow-xs">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors ${filter === f.key ? 'bg-accent text-primary' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {f.label}
              <span className={`rounded-full px-1.5 text-xs tabular-nums ${filter === f.key ? 'bg-primary/15 text-primary' : 'bg-surface-sunken text-text-subtle'}`}>{f.count}</span>
            </button>
          ))}
        </div>
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products or SKU"
            className="h-10 w-full rounded-xl border border-hairline bg-surface pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-text-subtle focus:border-input"
          />
        </div>
      </div>

      {/* Stock table */}
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-sm">
        <table className="w-full">
          <thead className="border-b border-hairline bg-surface-sunken">
            <tr className="[&>th]:p-4 [&>th]:text-[11px] [&>th]:font-bold [&>th]:uppercase [&>th]:tracking-wide [&>th]:text-text-subtle">
              <th className="text-left">Product</th>
              <th className="text-right">On hand</th>
              <th className="text-right">Threshold</th>
              <th className="text-center">Status</th>
              <th className="text-right">Value</th>
              <th className="text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map((p) => {
              const st = stockState(p.stock_quantity, p.low_stock_threshold);
              const meta = STATE_META[st];
              return (
                <tr key={p.id} className="hover:bg-surface-sunken">
                  <td className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: nameToColor(p.name) }}>
                        <span className="text-sm font-bold text-white/80">{p.name.substring(0, 2).toUpperCase()}</span>
                      </div>
                      <div>
                        <p className="font-medium text-foreground">{p.name}</p>
                        {p.sku && <p className="mt-0.5 text-xs text-muted-foreground">SKU: {p.sku}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="p-4 text-right">
                    <span className={`text-base font-semibold tabular-nums ${st === 'out' ? 'text-danger' : st === 'low' ? 'text-warning' : 'text-foreground'}`}>
                      {p.stock_quantity}
                    </span>
                  </td>
                  <td className="p-4 text-right text-sm tabular-nums text-muted-foreground">{p.low_stock_threshold || 0}</td>
                  <td className="p-4 text-center">
                    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${meta.cls}`}>{meta.label}</span>
                  </td>
                  <td className="p-4 text-right text-sm tabular-nums text-muted-foreground">
                    {fmt(Number(p.price || 0) * Math.max(0, p.stock_quantity || 0))}
                  </td>
                  <td className="p-4 text-right">
                    <Button size="sm" variant="outline" className="h-8 rounded-lg" onClick={() => openDetail(p)}>Adjust</Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-surface-sunken text-text-subtle">
              {products.length === 0 ? <Boxes className="size-6" /> : <PackageSearch className="size-6" />}
            </div>
            <p className="text-sm font-medium text-foreground">
              {products.length === 0 ? 'No products track inventory yet' : 'Nothing matches this view'}
            </p>
            <p className="text-xs text-text-subtle">
              {products.length === 0 ? 'Turn on stock tracking for a product in the Catalogue.' : 'Try a different filter or search term.'}
            </p>
          </div>
        )}
      </div>

      {/* Adjustment drawer */}
      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/40" onClick={closeDetail} />
          <aside className="relative flex h-full w-full max-w-[440px] flex-col bg-surface shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-hairline p-5">
              <div className="flex items-center gap-3">
                <div className="flex size-11 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: nameToColor(selected.name) }}>
                  <span className="text-base font-bold text-white/80">{selected.name.substring(0, 2).toUpperCase()}</span>
                </div>
                <div>
                  <h2 className="text-lg font-bold leading-tight text-foreground">{selected.name}</h2>
                  {selected.sku && <p className="text-xs text-muted-foreground">SKU: {selected.sku}</p>}
                </div>
              </div>
              <button onClick={closeDetail} className="rounded-lg p-1.5 text-text-subtle transition-colors hover:bg-hover hover:text-foreground">
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto p-5">
              {/* Current balance */}
              <div className="rounded-2xl border border-hairline bg-surface-sunken p-4">
                <p className="text-[11px] font-bold uppercase tracking-wide text-text-subtle">Current stock</p>
                <p className="mt-1 text-4xl font-bold tabular-nums tracking-tight text-foreground">{balance ?? '—'}</p>
              </div>

              {variants.length > 0 && (
                <div>
                  <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-text-subtle">Variant</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => selectVariant(null)}
                      className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${!selectedVariant ? 'border-primary bg-accent text-primary' : 'border-hairline text-muted-foreground hover:bg-hover'}`}
                    >
                      Base product
                    </button>
                    {variants.map((v) => (
                      <button
                        key={v.id}
                        onClick={() => selectVariant(v)}
                        className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${selectedVariant?.id === v.id ? 'border-primary bg-accent text-primary' : 'border-hairline text-muted-foreground hover:bg-hover'}`}
                      >
                        {v.name || v.sku || v.id}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Adjustment form */}
              <div className="rounded-2xl border border-hairline p-4">
                <div className="mb-3 flex items-center gap-2">
                  <TriangleAlert className="size-4 text-warning" />
                  <p className="text-[11px] font-bold uppercase tracking-wide text-text-subtle">Record adjustment</p>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-foreground">Quantity change (+/-)</label>
                    <input
                      type="number"
                      value={adjustQty}
                      onChange={(e) => setAdjustQty(e.target.value)}
                      placeholder="e.g. -3"
                      className="h-10 w-full rounded-lg border border-border-strong px-3 text-sm outline-none focus:ring-2 focus:ring-brand"
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-foreground">Reason</label>
                    <input
                      value={adjustReason}
                      onChange={(e) => setAdjustReason(e.target.value)}
                      placeholder="e.g. Stock count correction"
                      className="h-10 w-full rounded-lg border border-border-strong px-3 text-sm outline-none focus:ring-2 focus:ring-brand"
                    />
                  </div>
                  <Button className="w-full" disabled={busy || !adjustQty || !adjustReason.trim()} onClick={submitAdjustment}>
                    Apply adjustment
                  </Button>
                </div>
              </div>

              {error && (
                <div className="rounded-lg border border-destructive/30 bg-danger-tint px-4 py-3 text-sm text-destructive">{error}</div>
              )}

              {/* History */}
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <History className="size-4 text-text-subtle" />
                  <p className="text-[11px] font-bold uppercase tracking-wide text-text-subtle">Movement history</p>
                </div>
                {history.length === 0 ? (
                  <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-hairline py-8 text-center">
                    <PackageX className="size-5 text-text-subtle" />
                    <p className="text-sm text-text-subtle">No movements yet</p>
                  </div>
                ) : (
                  <ul className="space-y-1">
                    {history.map((m) => (
                      <li key={m.id} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-sunken">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium capitalize text-foreground">{m.movement_type.replace(/_/g, ' ')}</p>
                          <p className="truncate text-xs text-text-subtle">
                            {parseDbTimestamp(m.created_at).toLocaleString()}{m.reason ? ` · ${m.reason}` : ''}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className={`text-sm font-semibold tabular-nums ${m.quantity_delta < 0 ? 'text-danger' : 'text-success'}`}>
                            {m.quantity_delta > 0 ? '+' : ''}{m.quantity_delta}
                          </p>
                          <p className="text-xs tabular-nums text-text-subtle">→ {m.balance_after}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
