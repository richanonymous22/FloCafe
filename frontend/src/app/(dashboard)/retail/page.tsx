'use client';

/**
 * Retail checkout (Milestone 3, Part B6; retoned + customer/receipt in the
 * Plemmo UI pass).
 *
 * Deliberately still the thin counter-sale screen documented in
 * docs/MILESTONE_3_VERTICALS_AND_RETAIL.md § Retail checkout — it talks only
 * to /api/retail and never touches tables, kitchen stations, or KDS.
 * Customer attach uses `POST /retail/checkout`'s existing `customer_id`
 * field (already supported server-side, previously unused by this page).
 * Discounts, offers, and hold/resume are NOT implemented here: the atomic
 * `/retail/checkout` orchestration has no discount/hold concept, and adding
 * one is a real backend-surface decision, not a UI-only change — left for a
 * follow-up increment rather than rushed in under this one.
 */

import { useEffect, useRef, useState } from 'react';
import { Search, X, UserRound, ShoppingCart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusPill } from '@/components/ui/status-pill';
import api from '@/lib/api';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { Customer } from '@/lib/types';

interface CartLine {
  productId: string;
  variantId: string | null;
  name: string;
  price: number;
  quantity: number;
}

interface CheckoutResult {
  billTotal: number;
  billSubtotal: number;
  taxAmount: number;
  paymentState: string;
  orderNumber?: string | number;
  lines: { name: string; quantity: number; price: number }[];
}

export default function RetailCheckoutPage() {
  const [code, setCode] = useState('');
  const [lines, setLines] = useState<CartLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const fmt = useFormatCurrency();

  // Customer attach — self-contained search, not the shared /pos cart store,
  // so this screen never leaks state into (or out of) the hospitality till.
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [customerSearching, setCustomerSearching] = useState(false);
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const customerSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (customerSearchTimer.current) clearTimeout(customerSearchTimer.current);
    if (!customerQuery.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCustomerResults([]);
      return;
    }
    setCustomerSearching(true);
    customerSearchTimer.current = setTimeout(async () => {
      try {
        const res = await api.get('/customers', { params: { search: customerQuery.trim(), per_page: 8 } });
        setCustomerResults(res.data?.data || []);
      } catch {
        setCustomerResults([]);
      } finally {
        setCustomerSearching(false);
      }
    }, 300);
    return () => { if (customerSearchTimer.current) clearTimeout(customerSearchTimer.current); };
  }, [customerQuery]);

  const subtotal = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);

  async function scan() {
    setError(null);
    if (!code.trim()) return;
    setScanning(true);
    try {
      const res = await api.get('/retail/lookup', { params: { code: code.trim() } });
      const { kind, product, variant } = res.data;
      const line: CartLine = kind === 'variant'
        ? { productId: product.id, variantId: variant.id, name: `${product.name} — ${variant.name || variant.sku}`, price: variant.price, quantity: 1 }
        : { productId: product.id, variantId: null, name: product.name, price: product.price, quantity: 1 };

      setLines((prev) => {
        const existingIndex = prev.findIndex((l) => l.productId === line.productId && l.variantId === line.variantId);
        if (existingIndex >= 0) {
          const next = [...prev];
          next[existingIndex] = { ...next[existingIndex], quantity: next[existingIndex].quantity + 1 };
          return next;
        }
        return [...prev, line];
      });
      setCode('');
    } catch (err: unknown) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(message || 'No product or variant matches that code');
    } finally {
      setScanning(false);
    }
  }

  function updateQuantity(index: number, delta: number) {
    setLines((prev) => {
      const next = [...prev];
      const quantity = next[index].quantity + delta;
      if (quantity <= 0) {
        next.splice(index, 1);
      } else {
        next[index] = { ...next[index], quantity };
      }
      return next;
    });
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  function startNewSale() {
    setResult(null);
    setCustomer(null);
    setCustomerQuery('');
  }

  async function pay(adapter: 'cash' | 'manual_card') {
    if (lines.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/retail/checkout', {
        lines: lines.map((line) => ({ product_id: line.productId, variant_id: line.variantId, quantity: line.quantity })),
        customer_id: customer?.id ?? null,
        tender: { adapter, method: adapter === 'cash' ? 'cash' : 'card' },
      });
      const bill = res.data.bill || {};
      setResult({
        billTotal: Number(bill.total ?? subtotal),
        billSubtotal: Number(bill.subtotal ?? subtotal),
        taxAmount: Number(bill.tax_amount ?? 0),
        paymentState: res.data.payment?.state || 'paid',
        orderNumber: res.data.sale?.order_number ?? res.data.sale?.id,
        lines: lines.map((l) => ({ name: l.name, quantity: l.quantity, price: l.price })),
      });
      setLines([]);
      try { await api.post('/retail/cash-drawer/open'); } catch { /* best-effort — no printer configured is a normal state */ }
    } catch (err: unknown) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(message || 'Checkout failed');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="p-4 md:p-6 max-w-md mx-auto space-y-4">
        <Card>
          <CardContent className="pt-6 text-center space-y-3">
            <StatusPill tone="success" className="mx-auto">
              Payment {result.paymentState}
            </StatusPill>
            {result.orderNumber && (
              <p className="text-sm text-muted-foreground">Order #{result.orderNumber}</p>
            )}
            <div className="text-left border-t border-border pt-3 space-y-1">
              {result.lines.map((line, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="text-foreground">{line.quantity}× {line.name}</span>
                  <span className="text-muted-foreground">{fmt(line.price * line.quantity)}</span>
                </div>
              ))}
            </div>
            <div className="border-t border-border pt-3 space-y-1">
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>Subtotal</span>
                <span>{fmt(result.billSubtotal)}</span>
              </div>
              {result.taxAmount > 0 && (
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>Tax</span>
                  <span>{fmt(result.taxAmount)}</span>
                </div>
              )}
              <div className="flex justify-between text-lg font-semibold text-foreground">
                <span>Total</span>
                <span>{fmt(result.billTotal)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
        <Button className="w-full" size="lg" onClick={startNewSale}>New sale</Button>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
      <h1 className="text-2xl font-semibold text-foreground">Retail checkout</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scan or search</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Input
            autoFocus
            placeholder="Barcode or SKU"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') scan(); }}
          />
          <Button onClick={scan} disabled={scanning}>{scanning ? 'Adding…' : 'Add'}</Button>
        </CardContent>
      </Card>

      {error && <div className="text-destructive text-sm">{error}</div>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-1.5">
            <UserRound size={16} className="text-muted-foreground" />
            Customer
          </CardTitle>
        </CardHeader>
        <CardContent>
          {customer ? (
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/50 px-3 py-2">
              <div>
                <p className="text-sm font-medium text-foreground">{customer.name}</p>
                {customer.phone && <p className="text-xs text-muted-foreground">{customer.phone}</p>}
              </div>
              <button
                type="button"
                onClick={() => setCustomer(null)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Remove customer"
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                className="pl-8"
                placeholder="Search customer by name or phone (optional)"
                value={customerQuery}
                onChange={(e) => { setCustomerQuery(e.target.value); setShowCustomerDropdown(true); }}
                onFocus={() => setShowCustomerDropdown(true)}
                onBlur={() => setTimeout(() => setShowCustomerDropdown(false), 150)}
              />
              {showCustomerDropdown && customerQuery.trim() && (
                <div className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-card shadow-lg max-h-56 overflow-y-auto">
                  {customerSearching ? (
                    <p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p>
                  ) : customerResults.length === 0 ? (
                    <p className="px-3 py-2 text-sm text-muted-foreground">No matching customers</p>
                  ) : (
                    customerResults.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => { setCustomer(c); setCustomerQuery(''); setShowCustomerDropdown(false); }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
                      >
                        <span className="font-medium text-foreground">{c.name}</span>
                        {c.phone && <span className="text-muted-foreground"> · {c.phone}</span>}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cart</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {lines.length === 0 && (
            <EmptyState
              icon={<ShoppingCart />}
              title="Cart is empty"
              description="Scan a barcode or search a SKU above to add items."
            />
          )}
          {lines.map((line, index) => (
            <div key={`${line.productId}:${line.variantId ?? ''}`} className="flex items-center justify-between gap-2 border-b border-border pb-2 last:border-0">
              <div className="flex-1">
                <div className="font-medium text-foreground">{line.name}</div>
                <div className="text-sm text-muted-foreground">{fmt(line.price)} each</div>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => updateQuantity(index, -1)}>-</Button>
                <span className="w-8 text-center">{line.quantity}</span>
                <Button size="sm" variant="outline" onClick={() => updateQuantity(index, 1)}>+</Button>
                <Button size="sm" variant="ghost" onClick={() => removeLine(index)}>Remove</Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center justify-between pt-6">
          <span className="text-lg font-semibold text-foreground">Subtotal</span>
          <span className="text-lg font-semibold text-brand">{fmt(subtotal)}</span>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button className="flex-1" size="lg" disabled={busy || lines.length === 0} onClick={() => pay('cash')}>
          {busy ? 'Processing…' : 'Cash'}
        </Button>
        <Button className="flex-1" size="lg" variant="secondary" disabled={busy || lines.length === 0} onClick={() => pay('manual_card')}>
          {busy ? 'Processing…' : 'Card'}
        </Button>
      </div>
    </div>
  );
}
