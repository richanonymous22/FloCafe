'use client';

/**
 * Retail checkout (Milestone 3, Part B6).
 *
 * Deliberately minimal — a working, touch-friendly counter-sale screen, not
 * the final retail UI. It talks only to /api/retail and never touches
 * tables, kitchen stations, or KDS. See
 * docs/MILESTONE_3_VERTICALS_AND_RETAIL.md § Retail checkout for what is
 * intentionally left out (multi-line editing polish, held carts, receipts
 * preview, keyboard-first barcode scanning UX) and why.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import api from '@/lib/api';

interface CartLine {
  productId: string;
  variantId: string | null;
  name: string;
  price: number;
  quantity: number;
}

export default function RetailCheckoutPage() {
  const [code, setCode] = useState('');
  const [lines, setLines] = useState<CartLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ billTotal: number; paymentState: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const subtotal = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);

  async function scan() {
    setError(null);
    if (!code.trim()) return;
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

  async function pay(adapter: 'cash' | 'manual_card') {
    if (lines.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/retail/checkout', {
        lines: lines.map((line) => ({ product_id: line.productId, variant_id: line.variantId, quantity: line.quantity })),
        tender: { adapter, method: adapter === 'cash' ? 'cash' : 'card' },
      });
      setResult({ billTotal: res.data.bill.total, paymentState: res.data.payment.state });
      setLines([]);
      try { await api.post('/retail/cash-drawer/open'); } catch { /* best-effort — no printer configured is a normal state */ }
    } catch (err: unknown) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(message || 'Checkout failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
      <h1 className="text-2xl font-semibold">Retail checkout</h1>

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
          <Button onClick={scan}>Add</Button>
        </CardContent>
      </Card>

      {error && <div className="text-destructive text-sm">{error}</div>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cart</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {lines.length === 0 && <p className="text-muted-foreground text-sm">No items yet — scan something above.</p>}
          {lines.map((line, index) => (
            <div key={`${line.productId}:${line.variantId ?? ''}`} className="flex items-center justify-between gap-2 border-b pb-2 last:border-0">
              <div className="flex-1">
                <div className="font-medium">{line.name}</div>
                <div className="text-sm text-muted-foreground">{line.price.toFixed(2)} each</div>
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
          <span className="text-lg font-semibold">Subtotal</span>
          <span className="text-lg font-semibold">{subtotal.toFixed(2)}</span>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button className="flex-1" size="lg" disabled={busy || lines.length === 0} onClick={() => pay('cash')}>
          Cash
        </Button>
        <Button className="flex-1" size="lg" variant="secondary" disabled={busy || lines.length === 0} onClick={() => pay('manual_card')}>
          Card
        </Button>
      </div>

      {result && (
        <Card>
          <CardContent className="pt-6 text-center space-y-1">
            <div className="text-green-600 font-semibold">Payment {result.paymentState}</div>
            <div>Total: {result.billTotal.toFixed(2)}</div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
