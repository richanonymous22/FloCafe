'use client';

/**
 * Purchasing (Milestone 5, Part K). Deliberately minimal — create a draft
 * PO, add items by product search, mark ordered, receive goods showing
 * Ordered/Received/Remaining per line. Not the final UI.
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import api from '@/lib/api';

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

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4">
      <h1 className="text-display-lg text-3xl text-foreground">Purchasing</h1>
      {error && <div className="text-destructive text-sm">{error}</div>}

      <Card>
        <CardHeader><CardTitle className="text-base">New purchase order</CardTitle></CardHeader>
        <CardContent className="flex gap-2">
          <select className="border rounded-md px-3 py-2 text-sm flex-1" value={newSupplierId} onChange={(e) => setNewSupplierId(e.target.value)}>
            <option value="">Select supplier…</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <Button disabled={busy} onClick={createOrder}>Create draft PO</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Purchase orders</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          {orders.map((po) => (
            <Button key={po.id} variant={selected?.id === po.id ? 'secondary' : 'outline'} className="w-full justify-between" onClick={() => openOrder(po.id)}>
              <span>{po.reference_number || po.id.slice(0, 8)}</span>
              <span className="text-muted-foreground text-xs uppercase">{po.status}</span>
            </Button>
          ))}
          {orders.length === 0 && <p className="text-muted-foreground text-sm">No purchase orders yet.</p>}
        </CardContent>
      </Card>

      {selected && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {selected.reference_number || selected.id.slice(0, 8)} — <span className="uppercase">{selected.status}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {selected.status === 'draft' && (
              <div className="space-y-2 border-b pb-4">
                <div className="flex gap-2">
                  <Input placeholder="Search products" value={productSearch} onChange={(e) => setProductSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') searchProducts(); }} />
                  <Button variant="outline" onClick={searchProducts}>Search</Button>
                </div>
                {productResults.length > 0 && (
                  <div className="space-y-1">
                    {productResults.map((p) => (
                      <Button key={p.id} size="sm" variant={selectedProduct?.id === p.id ? 'secondary' : 'outline'} className="w-full justify-start" onClick={() => setSelectedProduct(p)}>
                        {p.name}
                      </Button>
                    ))}
                  </div>
                )}
                {selectedProduct && (
                  <div className="flex gap-2 items-end">
                    <div>
                      <label className="text-sm text-muted-foreground">Quantity</label>
                      <Input type="number" value={itemQty} onChange={(e) => setItemQty(e.target.value)} />
                    </div>
                    <div>
                      <label className="text-sm text-muted-foreground">Unit cost</label>
                      <Input type="number" value={itemCost} onChange={(e) => setItemCost(e.target.value)} />
                    </div>
                    <Button disabled={busy} onClick={addItem}>Add item</Button>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              {selected.items.map((item) => {
                const remaining = item.quantity_ordered - item.quantity_received;
                return (
                  <div key={item.id} className="border-b pb-2 last:border-0">
                    <div className="flex justify-between text-sm">
                      <span>{item.product_id}{item.product_variant_id ? ` (${item.product_variant_id})` : ''}</span>
                      <span>@ {item.unit_cost}</span>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Ordered: {item.quantity_ordered} · Received: {item.quantity_received} · Remaining: {remaining}
                    </div>
                    {(selected.status === 'ordered' || selected.status === 'partially_received') && remaining > 0 && (
                      <div className="flex gap-2 mt-1">
                        <Input type="number" placeholder={`Up to ${remaining}`} value={receiveQty[item.id] || ''} onChange={(e) => setReceiveQty({ ...receiveQty, [item.id]: e.target.value })} />
                        <Button size="sm" disabled={busy} onClick={() => receive(item)}>Receive</Button>
                      </div>
                    )}
                  </div>
                );
              })}
              {selected.items.length === 0 && <p className="text-muted-foreground text-sm">No items yet.</p>}
            </div>

            <div className="flex justify-between font-semibold">
              <span>Total</span>
              <span>{selected.total.toFixed(2)}</span>
            </div>

            <div className="flex gap-2">
              {selected.status === 'draft' && <Button onClick={markOrdered}>Mark ordered</Button>}
              {(selected.status === 'draft' || selected.status === 'ordered' || selected.status === 'partially_received') && (
                <Button variant="destructive" onClick={cancelOrder}>Cancel</Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Purchases by supplier</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          {supplierTotals.map((row) => (
            <div key={row.supplierId} className="flex justify-between text-sm border-b pb-1 last:border-0">
              <span>{row.supplierName} ({row.orderCount})</span>
              <span>{row.totalValue.toFixed(2)}</span>
            </div>
          ))}
          {supplierTotals.length === 0 && <p className="text-muted-foreground text-sm">No purchases yet.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Recent goods received</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          {recentReceipts.map((r) => (
            <div key={r.id} className="flex justify-between text-sm border-b pb-1 last:border-0">
              <span>{new Date(r.created_at).toLocaleString()} — {r.product_name} from {r.supplier_name}</span>
              <span>+{r.quantity_delta} @ {r.unit_cost}</span>
            </div>
          ))}
          {recentReceipts.length === 0 && <p className="text-muted-foreground text-sm">No goods received yet.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
