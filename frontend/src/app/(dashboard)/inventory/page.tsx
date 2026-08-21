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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4">
      <h1 className="text-display-lg text-3xl text-foreground">Inventory</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Low stock</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {lowStock.length === 0 && <p className="text-muted-foreground text-sm">Nothing is low right now.</p>}
          {lowStock.map((row) => (
            <div key={`${row.productId}:${row.variantId ?? ''}`} className="flex items-center justify-between text-sm border-b pb-1 last:border-0">
              <span>{row.productName}{row.variantName ? ` — ${row.variantName}` : ''}</span>
              <span className={row.quantity <= 0 ? 'text-destructive font-medium' : 'text-amber-600 font-medium'}>
                {row.quantity} / {row.threshold}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Find a product</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Input
              placeholder="Search products"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
            />
            <Button onClick={runSearch}>Search</Button>
          </div>
          {results.length > 0 && (
            <div className="space-y-1">
              {results.map((product) => (
                <Button
                  key={product.id}
                  variant={selectedProduct?.id === product.id ? 'secondary' : 'outline'}
                  className="w-full justify-start"
                  onClick={() => selectProduct(product)}
                >
                  {product.name}
                </Button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {error && <div className="text-destructive text-sm">{error}</div>}

      {selectedProduct && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{selectedProduct.name}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {variants.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant={!selectedVariant ? 'secondary' : 'outline'} onClick={() => selectVariant(null)}>
                  Base product
                </Button>
                {variants.map((variant) => (
                  <Button
                    key={variant.id}
                    size="sm"
                    variant={selectedVariant?.id === variant.id ? 'secondary' : 'outline'}
                    onClick={() => selectVariant(variant)}
                  >
                    {variant.name || variant.sku || variant.id}
                  </Button>
                ))}
              </div>
            )}

            <div className="text-lg font-semibold">Current stock: {balance ?? '—'}</div>

            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <label className="text-sm text-muted-foreground">Adjustment (+/-)</label>
                <Input type="number" value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)} />
              </div>
              <div className="flex-1">
                <label className="text-sm text-muted-foreground">Reason</label>
                <Input value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} placeholder="e.g. Stock count correction" />
              </div>
              <Button disabled={busy || !adjustQty || !adjustReason.trim()} onClick={submitAdjustment}>
                Apply
              </Button>
            </div>

            <div>
              <h3 className="font-medium mb-2">History</h3>
              <div className="space-y-1 text-sm">
                {history.length === 0 && <p className="text-muted-foreground">No movements yet.</p>}
                {history.map((movement) => (
                  <div key={movement.id} className="flex justify-between border-b pb-1 last:border-0">
                    <span>{new Date(movement.created_at).toLocaleString()} — {movement.movement_type}{movement.reason ? ` (${movement.reason})` : ''}</span>
                    <span className={movement.quantity_delta < 0 ? 'text-destructive' : 'text-green-600'}>
                      {movement.quantity_delta > 0 ? '+' : ''}{movement.quantity_delta} → {movement.balance_after}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
