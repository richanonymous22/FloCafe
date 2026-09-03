'use client';

/**
 * Stock transfers (Milestone 6, Part Q). Create a draft transfer between
 * two locations, add items via product search, complete or cancel. Not the
 * final UI.
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { ArrowLeftRight } from 'lucide-react';
import api from '@/lib/api';

interface Location { id: string; name: string; }
interface Product { id: string; name: string; }
interface TransferItem { id: string; product_id: string; product_variant_id: string | null; quantity: number; }
interface Transfer {
  id: string; status: string; from_location_id: string; to_location_id: string;
  reference_number: string | null; items: TransferItem[];
}

function errorMessage(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return message || fallback;
}

export default function TransfersPage() {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [selected, setSelected] = useState<Transfer | null>(null);
  const [productSearch, setProductSearch] = useState('');
  const [productResults, setProductResults] = useState<Product[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [itemQty, setItemQty] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadTransfers() {
    const res = await api.get('/transfers');
    setTransfers(res.data.transfers);
  }

  useEffect(() => {
    Promise.all([api.get('/transfers'), api.get('/locations')])
      .then(([transferRes, locRes]) => { setTransfers(transferRes.data.transfers); setLocations(locRes.data.locations); })
      .catch((err) => setError(errorMessage(err, 'Could not load transfers')));
  }, []);

  async function openTransfer(id: string) {
    try {
      const res = await api.get(`/transfers/${id}`);
      setSelected(res.data.transfer);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Could not load transfer'));
    }
  }

  async function createTransfer() {
    if (!fromLocationId || !toLocationId) { setError('Choose both locations'); return; }
    if (fromLocationId === toLocationId) { setError('Source and destination must differ'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/transfers', { from_location_id: fromLocationId, to_location_id: toLocationId });
      await loadTransfers();
      await openTransfer(res.data.transfer.id);
    } catch (err) {
      setError(errorMessage(err, 'Could not create transfer'));
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
    if (!selected || !selectedProduct || !itemQty) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/transfers/${selected.id}/items`, { product_id: selectedProduct.id, quantity: Number(itemQty) });
      setSelectedProduct(null);
      setItemQty('');
      setProductResults([]);
      setProductSearch('');
      await openTransfer(selected.id);
    } catch (err) {
      setError(errorMessage(err, 'Could not add item'));
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/transfers/${selected.id}/complete`);
      await openTransfer(selected.id);
      await loadTransfers();
    } catch (err) {
      setError(errorMessage(err, 'Could not complete transfer'));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!selected) return;
    try {
      await api.post(`/transfers/${selected.id}/cancel`);
      await openTransfer(selected.id);
      await loadTransfers();
    } catch (err) {
      setError(errorMessage(err, 'Could not cancel transfer'));
    }
  }

  function locationName(id: string): string {
    return locations.find((l) => l.id === id)?.name || id.slice(0, 8);
  }

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4">
      <h1 className="text-2xl font-semibold">Stock transfers</h1>
      {error && <div className="text-destructive text-sm">{error}</div>}

      <Card>
        <CardHeader><CardTitle className="text-base">New transfer</CardTitle></CardHeader>
        <CardContent className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-sm text-muted-foreground">From</label>
            <select className="border rounded-md px-3 py-2 text-sm w-full" value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)}>
              <option value="">Select…</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="flex-1">
            <label className="text-sm text-muted-foreground">To</label>
            <select className="border rounded-md px-3 py-2 text-sm w-full" value={toLocationId} onChange={(e) => setToLocationId(e.target.value)}>
              <option value="">Select…</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <Button disabled={busy} onClick={createTransfer}>Create draft</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Transfers</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          {transfers.map((t) => (
            <Button key={t.id} variant={selected?.id === t.id ? 'secondary' : 'outline'} className="w-full justify-between" onClick={() => openTransfer(t.id)}>
              <span>{locationName(t.from_location_id)} → {locationName(t.to_location_id)}</span>
              <span className="text-muted-foreground text-xs uppercase">{t.status}</span>
            </Button>
          ))}
          {transfers.length === 0 && (
            <EmptyState
              icon={<ArrowLeftRight />}
              title="No transfers yet"
              description="Stock transfers between locations will show up here."
            />
          )}
        </CardContent>
      </Card>

      {selected && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {locationName(selected.from_location_id)} → {locationName(selected.to_location_id)} — <span className="uppercase">{selected.status}</span>
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
                    <Input type="number" placeholder="Quantity" value={itemQty} onChange={(e) => setItemQty(e.target.value)} />
                    <Button disabled={busy} onClick={addItem}>Add item</Button>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1">
              {selected.items.map((item) => (
                <div key={item.id} className="flex justify-between text-sm border-b pb-1 last:border-0">
                  <span>{item.product_id}{item.product_variant_id ? ` (${item.product_variant_id})` : ''}</span>
                  <span>{item.quantity}</span>
                </div>
              ))}
              {selected.items.length === 0 && <p className="text-muted-foreground text-sm">No items yet.</p>}
            </div>

            {selected.status === 'draft' && (
              <div className="flex gap-2">
                <Button disabled={busy} onClick={complete}>Complete transfer</Button>
                <Button variant="destructive" onClick={cancel}>Cancel</Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
