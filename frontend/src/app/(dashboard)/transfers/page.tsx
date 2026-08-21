'use client';

/**
 * Stock transfers (Milestone 6, Part Q). Create a draft transfer between
 * two locations, add items via product search, complete or cancel. Not the
 * final UI.
 */

import { useEffect, useState } from 'react';
import { Plus, Search, ArrowRight, ArrowLeftRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import api from '@/lib/api';

const TR_STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'bg-surface-sunken text-text-subtle' },
  completed: { label: 'Completed', cls: 'bg-success-tint text-success' },
  cancelled: { label: 'Cancelled', cls: 'bg-danger-tint text-danger' },
};

function StatusPill({ status }: { status: string }) {
  const meta = TR_STATUS[status] || { label: status, cls: 'bg-surface-sunken text-text-subtle' };
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

  const draftCount = transfers.filter((t) => t.status === 'draft').length;
  const completedCount = transfers.filter((t) => t.status === 'completed').length;

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Stock transfers</h1>
        <p className="mt-0.5 text-sm text-text-subtle">Move stock between your locations and keep balances in sync.</p>
      </div>

      {error && <div className="rounded-lg border border-destructive/30 bg-danger-tint px-4 py-3 text-sm text-destructive">{error}</div>}

      {/* KPI band */}
      <div className="grid grid-cols-3 gap-4">
        <KpiCard label="Transfers" value={String(transfers.length)} sub="all time" />
        <KpiCard label="Drafts" value={String(draftCount)} sub="not yet sent" />
        <KpiCard label="Completed" value={String(completedCount)} sub="stock moved" />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[380px_1fr]">
        {/* Left rail */}
        <div className="space-y-4">
          <div className="rounded-2xl border border-hairline bg-surface p-5 shadow-sm">
            <h2 className="mb-3 text-sm font-bold text-foreground">New transfer</h2>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-text-subtle">From</label>
                <select className="h-10 w-full rounded-xl border border-hairline bg-surface px-3 text-sm text-foreground outline-none focus:border-input" value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)}>
                  <option value="">Select…</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
              <div className="flex justify-center text-text-subtle"><ArrowRight size={16} className="rotate-90" /></div>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-subtle">To</label>
                <select className="h-10 w-full rounded-xl border border-hairline bg-surface px-3 text-sm text-foreground outline-none focus:border-input" value={toLocationId} onChange={(e) => setToLocationId(e.target.value)}>
                  <option value="">Select…</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
              <Button disabled={busy} onClick={createTransfer} className="w-full gap-2 rounded-xl font-semibold"><Plus size={16} /> Create draft</Button>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-sm">
            <div className="border-b border-hairline px-5 py-3"><h2 className="text-sm font-bold text-foreground">Transfers</h2></div>
            <div className="divide-y divide-hairline">
              {transfers.map((t) => (
                <button
                  key={t.id}
                  onClick={() => openTransfer(t.id)}
                  className={`flex w-full items-center justify-between gap-2 px-5 py-3 text-left transition-colors hover:bg-surface-sunken ${selected?.id === t.id ? 'bg-accent/60' : ''}`}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    {locationName(t.from_location_id)} <ArrowRight size={13} className="text-text-subtle" /> {locationName(t.to_location_id)}
                  </span>
                  <StatusPill status={t.status} />
                </button>
              ))}
              {transfers.length === 0 && <p className="px-5 py-8 text-center text-sm text-muted-foreground">No transfers yet.</p>}
            </div>
          </div>
        </div>

        {/* Detail */}
        <div>
          {selected ? (
            <div className="rounded-2xl border border-hairline bg-surface shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-hairline p-5">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wide text-text-subtle">Transfer</p>
                  <h2 className="flex items-center gap-2 text-lg font-bold text-foreground">
                    {locationName(selected.from_location_id)} <ArrowRight size={16} className="text-text-subtle" /> {locationName(selected.to_location_id)}
                  </h2>
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
                      <div className="flex items-end gap-2">
                        <div className="flex-1">
                          <label className="mb-1 block text-xs font-medium text-text-subtle">Quantity of {selectedProduct.name}</label>
                          <Input type="number" placeholder="Quantity" value={itemQty} onChange={(e) => setItemQty(e.target.value)} className="h-10 rounded-lg border-hairline bg-surface" />
                        </div>
                        <Button disabled={busy} onClick={addItem} className="h-10 rounded-lg font-semibold">Add item</Button>
                      </div>
                    )}
                  </div>
                )}

                <div className="divide-y divide-hairline">
                  {selected.items.map((item) => (
                    <div key={item.id} className="flex items-center justify-between py-2.5 text-sm first:pt-0">
                      <span className="font-medium text-foreground">{item.product_id}{item.product_variant_id ? ` (${item.product_variant_id})` : ''}</span>
                      <span className="font-semibold tabular-nums text-foreground">{item.quantity}</span>
                    </div>
                  ))}
                  {selected.items.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No items yet.</p>}
                </div>

                {selected.status === 'draft' && (
                  <div className="flex gap-2 border-t border-hairline pt-4">
                    <Button disabled={busy} onClick={complete} className="rounded-xl font-semibold">Complete transfer</Button>
                    <Button variant="outline" onClick={cancel} className="rounded-xl text-danger hover:bg-danger-tint hover:text-danger">Cancel</Button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-hairline bg-surface py-20 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-surface-sunken text-text-subtle"><ArrowLeftRight className="size-6" /></div>
              <p className="text-sm font-medium text-foreground">Select a transfer</p>
              <p className="text-xs text-text-subtle">Pick one from the list, or create a new draft.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
