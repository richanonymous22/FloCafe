'use client';

/**
 * Retail checkout (Milestone 3, Part B6 origin; moved onto the granular
 * order/bill/payment flow for the Plemmo UI pass so it can reuse discounts,
 * customer attach, and — via PrepaidCheckoutModal's already-tested PIN/
 * approval and idempotency handling — get hold/resume for free later once a
 * held-order concept exists for non-table sales).
 *
 * This no longer calls the atomic POST /retail/checkout (main/modules/
 * retail/checkout.ts, still used by nothing now but kept for API compat —
 * see that module's docstring). It drives exactly the sequence
 * pos/page.tsx's prepaid checkout already drives — POST /orders (type:
 * 'in_store') -> PATCH /orders/:id/discount -> POST /bills/generate ->
 * POST /bills/:id/payments — the same Core engine, same PaymentModal-family
 * UI, same PIN-approval rules. Retail still never touches tables, kitchen
 * stations, or KDS: `type: 'in_store'` carries no table_id, so the
 * hospitality table-occupation hook finds nothing to do.
 *
 * Deliberately reuses the shared /pos cart store (useCartStore) so
 * PrepaidCheckoutModal — which reads cart.items/cart.customer directly —
 * works unmodified. To keep that from leaking into the hospitality till,
 * this page clears the store on both mount and unmount.
 */

import { useEffect, useRef, useState } from 'react';
import { Search, X, UserRound, ShoppingCart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusPill } from '@/components/ui/status-pill';
import PrepaidCheckoutModal, { type PrepaidPayment, type PrepaidDiscount } from '@/components/pos/PrepaidCheckoutModal';
import api from '@/lib/api';
import { useCartStore } from '@/store/cart';
import { useAuthStore } from '@/store/auth';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { getCurrencySymbol, getCountryByCode } from '@/lib/countries';
import type { Customer, Product } from '@/lib/types';

interface CheckoutResult {
  billTotal: number;
  billSubtotal: number;
  taxAmount: number;
  discountAmount: number;
  paymentState: string;
  orderNumber?: string | number;
  lines: { name: string; quantity: number; price: number }[];
}

function newIdempotencyKey(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `retail-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function RetailCheckoutPage() {
  const cart = useCartStore();
  const { currentTenant } = useAuthStore();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);
  const fmt = useFormatCurrency();
  const currencySymbol = getCurrencySymbol(currentTenant?.currency || 'INR', getCountryByCode(currentTenant?.country ?? 'IN')?.locale);

  // This screen is a self-contained counter-sale mode, not a "resume where
  // hospitality left off" surface — always start from an empty cart, and
  // never leave retail items sitting in the shared store for /pos to inherit.
  useEffect(() => {
    cart.clearCart();
    cart.setOrderType('takeaway');
    return () => { cart.clearCart(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Customer attach — searches the real /customers API directly; selection
  // is written into the shared cart store since that's what
  // PrepaidCheckoutModal (and the order-create payload below) both read.
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

  async function scan() {
    setError(null);
    if (!code.trim()) return;
    setScanning(true);
    try {
      const res = await api.get('/retail/lookup', { params: { code: code.trim() } });
      const { kind, product, variant } = res.data;
      const displayProduct: Product = kind === 'variant'
        ? { ...product, name: `${product.name} — ${variant.name || variant.sku}`, price: variant.price }
        : product;
      cart.addItem(displayProduct, 1, [], '', kind === 'variant' ? variant.id : null);
      setCode('');
    } catch (err: unknown) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(message || 'No product or variant matches that code');
    } finally {
      setScanning(false);
    }
  }

  function startNewSale() {
    setResult(null);
    cart.clearCart();
  }

  async function handleConfirmPayment(payments: PrepaidPayment[], walletAmount: number, discount: PrepaidDiscount | null) {
    setError(null);
    const items = cart.items;
    const lineSnapshot = items.map((item) => ({ name: item.product.name, quantity: item.quantity, price: Number(item.product.price) }));
    try {
      const { data: orderData } = await api.post('/orders', {
        customer_id: cart.customerId,
        type: 'in_store',
        items: items.map((item) => ({
          product_id: item.product.id,
          variant_id: item.variant_id ?? undefined,
          quantity: item.quantity,
        })),
      }, { headers: { 'Idempotency-Key': newIdempotencyKey() } });
      const orderId = orderData.order.id;

      if (discount && discount.value > 0) {
        await api.patch(`/orders/${orderId}/discount`, {
          discount_type: discount.type,
          discount_value: discount.value,
          discount_reason: discount.reason,
          override_pin: discount.override_pin,
        });
      }

      const { data: billData } = await api.post('/bills/generate', { order_id: orderId });
      const bill = billData.bill;

      const paymentLines = payments.filter((p) => p.amount > 0);
      if (walletAmount > 0) paymentLines.push({ method: 'wallet', amount: walletAmount });

      const paymentResponse = await api.post(
        `/bills/${bill.id}/payments`,
        { payments: paymentLines, customer_id: cart.customerId },
        { headers: { 'Idempotency-Key': newIdempotencyKey() } },
      );
      const paidBill = paymentResponse.data?.bill || bill;

      if (paidBill.payment_status !== 'paid') {
        throw new Error(`Payment incomplete — balance remaining ${fmt(Number(paidBill.balance) || 0)}`);
      }

      setResult({
        billTotal: Number(paidBill.total ?? 0),
        billSubtotal: Number(paidBill.subtotal ?? 0),
        taxAmount: Number(paidBill.tax_amount ?? 0),
        discountAmount: Number(paidBill.discount_amount ?? 0),
        paymentState: 'settled',
        orderNumber: orderData.order.order_number ?? orderId,
        lines: lineSnapshot,
      });
      setShowCheckout(false);
      cart.clearCart();
      try { await api.post('/retail/cash-drawer/open'); } catch { /* best-effort — no printer configured is a normal state */ }
    } catch (err: unknown) {
      const message = (err as { response?: { data?: { message?: string; error?: string } }; message?: string })?.response?.data?.message
        || (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        || (err as Error)?.message
        || 'Checkout failed';
      setError(message);
      setShowCheckout(false);
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
              {result.discountAmount > 0 && (
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>Discount</span>
                  <span>−{fmt(result.discountAmount)}</span>
                </div>
              )}
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
          {cart.customer ? (
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/50 px-3 py-2">
              <div>
                <p className="text-sm font-medium text-foreground">{cart.customer.name}</p>
                {cart.customer.phone && <p className="text-xs text-muted-foreground">{cart.customer.phone}</p>}
              </div>
              <button
                type="button"
                onClick={() => cart.setCustomer(null)}
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
                        onClick={() => { cart.setCustomer(c); setCustomerQuery(''); setShowCustomerDropdown(false); }}
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
          {cart.items.length === 0 && (
            <EmptyState
              icon={<ShoppingCart />}
              title="Cart is empty"
              description="Scan a barcode or search a SKU above to add items."
            />
          )}
          {cart.items.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-2 border-b border-border pb-2 last:border-0">
              <div className="flex-1">
                <div className="font-medium text-foreground">{item.product.name}</div>
                <div className="text-sm text-muted-foreground">{fmt(Number(item.product.price))} each</div>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => cart.updateQuantity(item.id, item.quantity - 1)}>-</Button>
                <span className="w-8 text-center">{item.quantity}</span>
                <Button size="sm" variant="outline" onClick={() => cart.updateQuantity(item.id, item.quantity + 1)}>+</Button>
                <Button size="sm" variant="ghost" onClick={() => cart.removeItem(item.id)}>Remove</Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center justify-between pt-6">
          <span className="text-lg font-semibold text-foreground">Subtotal</span>
          <span className="text-lg font-semibold text-brand">{fmt(cart.subtotal())}</span>
        </CardContent>
      </Card>

      <Button className="w-full" size="lg" disabled={cart.items.length === 0} onClick={() => setShowCheckout(true)}>
        Checkout
      </Button>

      {showCheckout && (
        <PrepaidCheckoutModal
          currency={currencySymbol}
          onClose={() => setShowCheckout(false)}
          onConfirm={handleConfirmPayment}
        />
      )}
    </div>
  );
}
