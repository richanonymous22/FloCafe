'use client';

/**
 * Inventory management (Milestone 4, Part U).
 *
 * Deliberately minimal — a working, touch-friendly stock view, not the
 * final inventory UI. Lets a merchant see low stock, look up a
 * product/variant's current balance and history, and record a manual
 * adjustment. No purchasing, suppliers, transfers, or forecasting — see
 * docs/MILESTONE_4_INVENTORY.md for what's intentionally deferred.
 */

import { useEffect, useState } from 'react';
import { Search, Boxes, PackageSearch, TriangleAlert, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, PageContainer } from '@/components/ui/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { EmptyState } from '@/components/ui/empty-state';
import { parseDbTimestamp } from '@/lib/utils';
import api from '@/lib/api';

interface Product {
  id: string;
  name: string;
  track_inventory: number;
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

interface LowStockRow {
  productId: string;
  productName: string;
  variantId: string | null;
  variantName: string | null;
  quantity: number;
  threshold: number;
}

function errorMessage(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return message || fallback;
}

export default function InventoryPage() {
  const [lowStock, setLowStock] = useState<LowStockRow[]>([]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [selectedVariant, setSelectedVariant] = useState<Variant | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [history, setHistory] = useState<Movement[]>([]);
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadLowStock() {
    try {
      const res = await api.get('/inventory/low-stock');
      setLowStock(res.data.items);
    } catch { /* best-effort */ }
  }

  useEffect(() => {
    api.get('/inventory/low-stock')
      .then((res) => setLowStock(res.data.items))
      .catch(() => { /* best-effort */ });
  }, []);

  async function runSearch() {
    if (!search.trim()) { setResults([]); return; }
    try {
      const res = await api.get('/products', { params: { search: search.trim(), active: 'true' } });
      setResults(res.data.products || res.data || []);
    } catch (err) {
      setError(errorMessage(err, 'Search failed'));
    }
  }

  async function selectProduct(product: Product) {
    setSelectedProduct(product);
    setSelectedVariant(null);
    setError(null);
    try {
      const res = await api.get('/retail/variants', { params: { product_id: product.id } });
      setVariants(res.data.variants || []);
    } catch {
      setVariants([]);
    }
    await loadBalanceAndHistory(product.id, null);
  }

  async function selectVariant(variant: Variant | null) {
    setSelectedVariant(variant);
    if (selectedProduct) await loadBalanceAndHistory(selectedProduct.id, variant?.id ?? null);
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
    if (!selectedProduct || !adjustQty || !adjustReason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/inventory/adjust', {
        product_id: selectedProduct.id,
        variant_id: selectedVariant?.id ?? null,
        quantity_delta: Number(adjustQty),
        reason: adjustReason.trim(),
      });
      setAdjustQty('');
      setAdjustReason('');
      await loadBalanceAndHistory(selectedProduct.id, selectedVariant?.id ?? null);
      await loadLowStock();
    } catch (err) {
      setError(errorMessage(err, 'Adjustment failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer className="max-w-5xl">
      <PageHeader
        eyebrow="Operations"
        title="Inventory"
        description="See what's low, look up a product's balance and history, and record adjustments."
      />

      <div className="animate-rise space-y-6">
        {/* Low stock */}
        <section className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-sm">
          <div className="flex items-center gap-2.5 border-b border-hairline px-5 py-4">
            <TriangleAlert className="size-4 text-warning" />
            <h2 className="eyebrow">Low stock</h2>
            {lowStock.length > 0 && (
              <span className="rounded-full bg-warning-tint px-2 py-0.5 text-xs font-semibold tabular-nums text-warning-foreground">
                {lowStock.length}
              </span>
            )}
          </div>
          {lowStock.length === 0 ? (
            <EmptyState compact icon={<Boxes className="size-5" />} title="Nothing is low right now" description="Stock levels are healthy across the catalogue." />
          ) : (
            <ul className="divide-y divide-hairline">
              {lowStock.map((row) => (
                <li key={`${row.productId}:${row.variantId ?? ''}`} className="flex items-center justify-between gap-3 px-5 py-3">
                  <span className="text-sm font-medium text-foreground">
                    {row.productName}{row.variantName ? ` — ${row.variantName}` : ''}
                  </span>
                  <StatusPill tone={row.quantity <= 0 ? 'danger' : 'warning'}>
                    <span className="tabular-nums">{row.quantity} / {row.threshold}</span>
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Find a product */}
        <section className="rounded-2xl border border-hairline bg-surface p-5 shadow-sm">
          <h2 className="eyebrow mb-3">Find a product</h2>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search products by name or SKU"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
                className="pl-9"
              />
            </div>
            <Button onClick={runSearch}>Search</Button>
          </div>
          {results.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {results.map((product) => (
                <Button
                  key={product.id}
                  size="sm"
                  variant={selectedProduct?.id === product.id ? 'default' : 'outline'}
                  onClick={() => selectProduct(product)}
                >
                  {product.name}
                </Button>
              ))}
            </div>
          )}
        </section>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-danger-tint px-4 py-3 text-sm text-destructive">{error}</div>
        )}

        {selectedProduct && (
          <section className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-sm">
            <div className="flex flex-col gap-4 border-b border-hairline p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="eyebrow mb-1">Selected product</p>
                <h2 className="text-display text-xl text-foreground">{selectedProduct.name}</h2>
              </div>
              <div className="text-right">
                <p className="eyebrow mb-0.5">Current stock</p>
                <p className="figure text-3xl text-foreground">{balance ?? '—'}</p>
              </div>
            </div>

            <div className="space-y-5 p-5">
              {variants.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant={!selectedVariant ? 'default' : 'outline'} onClick={() => selectVariant(null)}>
                    Base product
                  </Button>
                  {variants.map((variant) => (
                    <Button
                      key={variant.id}
                      size="sm"
                      variant={selectedVariant?.id === variant.id ? 'default' : 'outline'}
                      onClick={() => selectVariant(variant)}
                    >
                      {variant.name || variant.sku || variant.id}
                    </Button>
                  ))}
                </div>
              )}

              <div className="flex flex-col gap-3 rounded-xl border border-hairline bg-surface-sunken p-4 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <label className="eyebrow mb-1.5 block">Adjustment (+/-)</label>
                  <Input type="number" value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)} placeholder="e.g. -3" />
                </div>
                <div className="flex-1">
                  <label className="eyebrow mb-1.5 block">Reason</label>
                  <Input value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} placeholder="e.g. Stock count correction" />
                </div>
                <Button disabled={busy || !adjustQty || !adjustReason.trim()} onClick={submitAdjustment}>
                  Apply
                </Button>
              </div>

              <div>
                <div className="mb-3 flex items-center gap-2">
                  <History className="size-4 text-muted-foreground" />
                  <h3 className="eyebrow">Movement history</h3>
                </div>
                {history.length === 0 ? (
                  <EmptyState compact icon={<PackageSearch className="size-5" />} title="No movements yet" />
                ) : (
                  <ul className="divide-y divide-hairline text-sm">
                    {history.map((movement) => (
                      <li key={movement.id} className="flex items-center justify-between gap-3 py-2.5">
                        <span className="text-muted-foreground">
                          {parseDbTimestamp(movement.created_at).toLocaleString()} · {movement.movement_type}
                          {movement.reason ? ` (${movement.reason})` : ''}
                        </span>
                        <span className={`figure shrink-0 ${movement.quantity_delta < 0 ? 'text-destructive' : 'text-success'}`}>
                          {movement.quantity_delta > 0 ? '+' : ''}{movement.quantity_delta} → {movement.balance_after}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>
        )}
      </div>
    </PageContainer>
  );
}
