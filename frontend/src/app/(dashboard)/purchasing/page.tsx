'use client';

/**
 * Purchasing (Milestone 5, Part K). Deliberately minimal — create a draft
 * PO, add items by product search, mark ordered, receive goods showing
 * Ordered/Received/Remaining per line. Not the final UI.
 */

import { useEffect, useState } from 'react';
import { Plus, Search, PackageCheck, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import api from '@/lib/api';

const PO_STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'bg-surface-sunken text-text-subtle' },
  ordered: { label: 'Ordered', cls: 'bg-info-tint text-info' },
  partially_received: { label: 'Part received', cls: 'bg-warning-tint text-warning' },
  received: { label: 'Received', cls: 'bg-success-tint text-success' },
  cancelled: { label: 'Cancelled', cls: 'bg-danger-tint text-danger' },
};

function StatusPill({ status }: { status: string }) {
  const meta = PO_STATUS[status] || { label: status, cls: 'bg-surface-sunken text-text-subtle' };
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${meta.cls}`}>{meta.label}</span>;
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

interface Supplier { id: string; name: string; }
interface Product { id: string; name: string; }
interface POItem {
  id: string; product_id: string; product_variant_id: string | null;
  quantity_ordered: number; unit_cost: number; quantity_received: number;
}
interface PurchaseOrder {
  id: string; status: string; reference_number: string | null; supplier_id: string;
  subtotal: number; tax: number; total: number; items: POItem[];
}
interface SupplierTotal { supplierId: string; supplierName: string; orderCount: number; totalValue: number; }
interface Receipt { id: string; created_at: string; quantity_delta: number; unit_cost: number; product_name: string; supplier_name: string; reference_number: string | null; }

function errorMessage(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return message || fallback;
}

export default function PurchasingPage() {
  const fmt = useFormatCurrency();
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selected, setSelected] = useState<PurchaseOrder | null>(null);
  const [newSupplierId, setNewSupplierId] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [productResults, setProductResults] = useState<Product[]>([]);
  const [itemQty, setItemQty] = useState('');
  const [itemCost, setItemCost] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [supplierTotals, setSupplierTotals] = useState<SupplierTotal[]>([]);
  const [recentReceipts, setRecentReceipts] = useState<Receipt[]>([]);

  async function loadOrders() {
    const res = await api.get('/purchase-orders');
    setOrders(res.data.purchaseOrders);
  }

  async function loadReports() {
    const [bySupplierRes, receiptsRes] = await Promise.all([
      api.get('/purchase-orders/reports/by-supplier'),
      api.get('/purchase-orders/reports/recent-receipts', { params: { limit: 10 } }),
    ]);
    setSupplierTotals(bySupplierRes.data.suppliers);
    setRecentReceipts(receiptsRes.data.receipts);
  }

  useEffect(() => {
    Promise.all([
      api.get('/purchase-orders'),
      api.get('/suppliers', { params: { active: 'true' } }),
      api.get('/purchase-orders/reports/by-supplier'),
      api.get('/purchase-orders/reports/recent-receipts', { params: { limit: 10 } }),
    ])
      .then(([poRes, supRes, bySupplierRes, receiptsRes]) => {
        setOrders(poRes.data.purchaseOrders);
        setSuppliers(supRes.data.suppliers);
        setSupplierTotals(bySupplierRes.data.suppliers);
        setRecentReceipts(receiptsRes.data.receipts);
      })
      .catch((err) => setError(errorMessage(err, 'Could not load purchasing data')));
  }, []);

  async function openOrder(id: string) {
    try {
      const res = await api.get(`/purchase-orders/${id}`);
      setSelected(res.data.purchaseOrder);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Could not load purchase order'));
    }
  }

  async function createOrder() {
    if (!newSupplierId) { setError('Choose a supplier'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/purchase-orders', { supplier_id: newSupplierId });
      await loadOrders();
      await openOrder(res.data.purchaseOrder.id);
    } catch (err) {
      setError(errorMessage(err, 'Could not create purchase order'));
    } finally {
      setBusy(false);
    }
  }

  async function searchProducts() {
    if (!productSearch.trim()) return;
    const res = await api.get('/products', { params: { search: productSearch.trim(), active: 'true' } });
    setProductResults(res.data.products || res.data || []);
  }

  async function addItem() {
    if (!selected || !selectedProduct || !itemQty || !itemCost) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/purchase-orders/${selected.id}/items`, {
        product_id: selectedProduct.id, quantity_ordered: Number(itemQty), unit_cost: Number(itemCost),
      });
      setSelectedProduct(null);
      setItemQty('');
      setItemCost('');
      setProductResults([]);
      setProductSearch('');
      await openOrder(selected.id);
      await loadOrders();
    } catch (err) {
      setError(errorMessage(err, 'Could not add item'));
    } finally {
      setBusy(false);
    }
  }

  async function markOrdered() {
    if (!selected) return;
    try {
      await api.post(`/purchase-orders/${selected.id}/mark-ordered`);
      await openOrder(selected.id);
      await loadOrders();
    } catch (err) {
      setError(errorMessage(err, 'Could not mark ordered'));
    }
  }

  async function cancelOrder() {
    if (!selected) return;
    try {
      await api.post(`/purchase-orders/${selected.id}/cancel`);
      await openOrder(selected.id);
      await loadOrders();
    } catch (err) {
      setError(errorMessage(err, 'Could not cancel'));
    }
  }

  async function receive(item: POItem) {
    if (!selected) return;
    const quantity = Number(receiveQty[item.id]);
    if (!quantity || quantity <= 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/purchase-orders/${selected.id}/receive`, {
        items: [{ itemId: item.id, quantity }],
      });
      setReceiveQty({ ...receiveQty, [item.id]: '' });
      await openOrder(selected.id);
      await loadOrders();
      await loadReports();
    } catch (err) {
      setError(errorMessage(err, 'Could not receive goods'));
    } finally {
      setBusy(false);
    }
  }

  const openCount = orders.filter((o) => !['received', 'cancelled'].includes(o.status)).length;
  const draftCount = orders.filter((o) => o.status === 'draft').length;
  const awaitingCount = orders.filter((o) => ['ordered', 'partially_received'].includes(o.status)).length;
  const spend = supplierTotals.reduce((s, r) => s + Number(r.totalValue || 0), 0);

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Purchasing</h1>
        <p className="mt-0.5 text-sm text-text-subtle">Raise purchase orders, receive stock and track spend by supplier.</p>
      </div>

      {error && <div className="rounded-lg border border-destructive/30 bg-danger-tint px-4 py-3 text-sm text-destructive">{error}</div>}

      {/* KPI band */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Open orders" value={String(openCount)} sub="not yet closed" />
        <KpiCard label="Drafts" value={String(draftCount)} sub="still being built" />
        <KpiCard label="Awaiting receipt" value={String(awaitingCount)} sub="ordered, not in yet" />
        <KpiCard label="Spend to date" value={fmt(spend)} sub="across all suppliers" />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[380px_1fr]">
        {/* Left rail: create + list */}
        <div className="space-y-4">
          <div className="rounded-2xl border border-hairline bg-surface p-5 shadow-sm">
            <h2 className="mb-3 text-sm font-bold text-foreground">New purchase order</h2>
            <div className="space-y-2">
              <select className="h-10 w-full rounded-xl border border-hairline bg-surface px-3 text-sm text-foreground outline-none focus:border-input" value={newSupplierId} onChange={(e) => setNewSupplierId(e.target.value)}>
                <option value="">Select supplier…</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <Button disabled={busy} onClick={createOrder} className="w-full gap-2 rounded-xl font-semibold"><Plus size={16} /> Create draft PO</Button>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-sm">
            <div className="border-b border-hairline px-5 py-3">
              <h2 className="text-sm font-bold text-foreground">Purchase orders</h2>
            </div>
            <div className="divide-y divide-hairline">
              {orders.map((po) => (
                <button
                  key={po.id}
                  onClick={() => openOrder(po.id)}
                  className={`flex w-full items-center justify-between gap-2 px-5 py-3 text-left transition-colors hover:bg-surface-sunken ${selected?.id === po.id ? 'bg-accent/60' : ''}`}
                >
                  <span className="font-medium text-foreground">{po.reference_number || po.id.slice(0, 8)}</span>
                  <StatusPill status={po.status} />
                </button>
              ))}
              {orders.length === 0 && <p className="px-5 py-8 text-center text-sm text-muted-foreground">No purchase orders yet.</p>}
            </div>
          </div>
        </div>

        {/* Detail */}
        <div className="space-y-4">
          {selected ? (
            <div className="rounded-2xl border border-hairline bg-surface shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-hairline p-5">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wide text-text-subtle">Purchase order</p>
                  <h2 className="text-lg font-bold text-foreground">{selected.reference_number || selected.id.slice(0, 8)}</h2>
                </div>
                <StatusPill status={selected.status} />
              </div>

              <div className="space-y-5 p-5">
                {selected.status === 'draft' && (
                  <div className="space-y-3 rounded-xl border border-hairline bg-surface-sunken p-4">
                    <div className="relative">
                      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
                      <Input placeholder="Search products to add" value={productSearch} onChange={(e) => setProductSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') searchProducts(); }} className="h-10 rounded-lg border-hairline bg-surface pl-9" />
                    </div>
                    {productResults.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {productResults.map((p) => (
                          <button key={p.id} onClick={() => setSelectedProduct(p)} className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${selectedProduct?.id === p.id ? 'border-primary bg-accent text-primary' : 'border-hairline bg-surface text-muted-foreground hover:bg-hover'}`}>
                            {p.name}
                          </button>
                        ))}
                      </div>
                    )}
                    {selectedProduct && (
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="flex-1">
                          <label className="mb-1 block text-xs font-medium text-text-subtle">Quantity</label>
                          <Input type="number" value={itemQty} onChange={(e) => setItemQty(e.target.value)} className="h-10 rounded-lg border-hairline bg-surface" />
                        </div>
                        <div className="flex-1">
                          <label className="mb-1 block text-xs font-medium text-text-subtle">Unit cost</label>
                          <Input type="number" value={itemCost} onChange={(e) => setItemCost(e.target.value)} className="h-10 rounded-lg border-hairline bg-surface" />
                        </div>
                        <Button disabled={busy} onClick={addItem} className="h-10 rounded-lg font-semibold">Add item</Button>
                      </div>
                    )}
                  </div>
                )}

                <div className="divide-y divide-hairline">
                  {selected.items.map((item) => {
                    const remaining = item.quantity_ordered - item.quantity_received;
                    return (
                      <div key={item.id} className="py-3 first:pt-0">
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium text-foreground">{item.product_id}{item.product_variant_id ? ` (${item.product_variant_id})` : ''}</span>
                          <span className="text-muted-foreground">@ {fmt(Number(item.unit_cost))}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-text-subtle">
                          <span>Ordered <span className="font-semibold text-foreground">{item.quantity_ordered}</span></span>
                          <span>Received <span className="font-semibold text-success">{item.quantity_received}</span></span>
                          <span>Remaining <span className="font-semibold text-warning">{remaining}</span></span>
                        </div>
                        {(selected.status === 'ordered' || selected.status === 'partially_received') && remaining > 0 && (
                          <div className="mt-2 flex gap-2">
                            <Input type="number" placeholder={`Up to ${remaining}`} value={receiveQty[item.id] || ''} onChange={(e) => setReceiveQty({ ...receiveQty, [item.id]: e.target.value })} className="h-9 max-w-[160px] rounded-lg border-hairline" />
                            <Button size="sm" disabled={busy} onClick={() => receive(item)} className="rounded-lg">Receive</Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {selected.items.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No items yet.</p>}
                </div>

                <div className="flex items-center justify-between border-t border-hairline pt-4">
                  <span className="text-sm font-semibold text-text-subtle">Total</span>
                  <span className="text-xl font-bold text-foreground">{fmt(Number(selected.total))}</span>
                </div>

                <div className="flex gap-2">
                  {selected.status === 'draft' && <Button onClick={markOrdered} className="rounded-xl font-semibold">Mark ordered</Button>}
                  {(selected.status === 'draft' || selected.status === 'ordered' || selected.status === 'partially_received') && (
                    <Button variant="outline" onClick={cancelOrder} className="rounded-xl text-danger hover:bg-danger-tint hover:text-danger">Cancel</Button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-hairline bg-surface py-20 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-surface-sunken text-text-subtle"><FileText className="size-6" /></div>
              <p className="text-sm font-medium text-foreground">Select a purchase order</p>
              <p className="text-xs text-text-subtle">Pick one from the list, or create a new draft.</p>
            </div>
          )}
        </div>
      </div>

      {/* Reports */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-sm">
          <div className="border-b border-hairline px-5 py-3"><h2 className="text-sm font-bold text-foreground">Purchases by supplier</h2></div>
          <div className="divide-y divide-hairline">
            {supplierTotals.map((row) => (
              <div key={row.supplierId} className="flex items-center justify-between px-5 py-3 text-sm">
                <span className="text-foreground">{row.supplierName} <span className="text-text-subtle">· {row.orderCount} orders</span></span>
                <span className="font-semibold tabular-nums text-foreground">{fmt(Number(row.totalValue))}</span>
              </div>
            ))}
            {supplierTotals.length === 0 && <p className="px-5 py-8 text-center text-sm text-muted-foreground">No purchases yet.</p>}
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-sm">
          <div className="flex items-center gap-2 border-b border-hairline px-5 py-3"><PackageCheck size={16} className="text-success" /><h2 className="text-sm font-bold text-foreground">Recent goods received</h2></div>
          <div className="divide-y divide-hairline">
            {recentReceipts.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{r.product_name}</p>
                  <p className="truncate text-xs text-text-subtle">{new Date(r.created_at).toLocaleString()} · {r.supplier_name}</p>
                </div>
                <span className="shrink-0 font-semibold tabular-nums text-success">+{r.quantity_delta} <span className="font-normal text-text-subtle">@ {fmt(Number(r.unit_cost))}</span></span>
              </div>
            ))}
            {recentReceipts.length === 0 && <p className="px-5 py-8 text-center text-sm text-muted-foreground">No goods received yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
