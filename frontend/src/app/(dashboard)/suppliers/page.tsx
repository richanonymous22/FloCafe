'use client';

/**
 * Supplier management (Milestone 5, Part K). Deliberately minimal — list,
 * search, create/edit, deactivate. No purchasing here; that's /purchasing.
 */

import { useEffect, useState } from 'react';
import { Plus, Search, Mail, Phone, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { nameToColor } from '@/lib/image-utils';
import api from '@/lib/api';

function KpiCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-4 shadow-xs">
      <p className="text-[11px] font-bold uppercase tracking-wide text-text-subtle">{label}</p>
      <p className="mt-1.5 text-2xl font-bold tracking-tight text-foreground">{value}</p>
      <p className="mt-0.5 text-xs text-text-subtle">{sub}</p>
    </div>
  );
}

interface Supplier {
  id: string;
  name: string;
  business_name: string | null;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  is_active: number;
}

const EMPTY_FORM = { name: '', business_name: '', contact_person: '', phone: '', email: '', address: '', notes: '' };

function errorMessage(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return message || fallback;
}

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(searchTerm?: string) {
    try {
      const res = await api.get('/suppliers', { params: searchTerm ? { search: searchTerm } : undefined });
      setSuppliers(res.data.suppliers);
    } catch (err) {
      setError(errorMessage(err, 'Could not load suppliers'));
    }
  }

  useEffect(() => {
    api.get('/suppliers')
      .then((res) => setSuppliers(res.data.suppliers))
      .catch((err) => setError(errorMessage(err, 'Could not load suppliers')));
  }, []);

  function startCreate() {
    setEditingId('new');
    setForm(EMPTY_FORM);
    setError(null);
  }

  function startEdit(supplier: Supplier) {
    setEditingId(supplier.id);
    setForm({
      name: supplier.name, business_name: supplier.business_name || '', contact_person: supplier.contact_person || '',
      phone: supplier.phone || '', email: supplier.email || '', address: supplier.address || '', notes: supplier.notes || '',
    });
    setError(null);
  }

  async function save() {
    if (!form.name.trim()) { setError('Name is required'); return; }
    setBusy(true);
    setError(null);
    try {
      if (editingId && editingId !== 'new') {
        await api.put(`/suppliers/${editingId}`, form);
      } else {
        await api.post('/suppliers', form);
      }
      setEditingId(null);
      await load(search);
    } catch (err) {
      setError(errorMessage(err, 'Save failed'));
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(id: string) {
    try {
      await api.delete(`/suppliers/${id}`);
      await load(search);
    } catch (err) {
      setError(errorMessage(err, 'Could not deactivate supplier'));
    }
  }

  const activeCount = suppliers.filter((s) => s.is_active).length;
  const withContact = suppliers.filter((s) => s.phone || s.email).length;

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Suppliers</h1>
          <p className="mt-0.5 text-sm text-text-subtle">The vendors you buy stock from, and how to reach them.</p>
        </div>
        <Button onClick={startCreate} className="h-10 gap-2 rounded-xl font-semibold shadow-sm"><Plus size={16} /> New supplier</Button>
      </div>

      {/* KPI band */}
      <div className="grid grid-cols-3 gap-4">
        <KpiCard label="Suppliers" value={String(suppliers.length)} sub={`${activeCount} active`} />
        <KpiCard label="Active" value={String(activeCount)} sub="available to order from" />
        <KpiCard label="With contact" value={String(withContact)} sub="phone or email on file" />
      </div>

      <div className="relative">
        <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
        <Input
          placeholder="Search suppliers"
          value={search}
          onChange={(e) => { setSearch(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') load(search); }}
          className="h-11 rounded-xl border-hairline pl-10"
        />
      </div>

      {error && <div className="rounded-lg border border-destructive/30 bg-danger-tint px-4 py-3 text-sm text-destructive">{error}</div>}

      {editingId && (
        <div className="rounded-2xl border border-hairline bg-surface p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold text-foreground">{editingId === 'new' ? 'New supplier' : 'Edit supplier'}</h2>
            <button onClick={() => setEditingId(null)} className="rounded-lg p-1.5 text-text-subtle transition-colors hover:bg-hover hover:text-foreground"><X size={18} /></button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input placeholder="Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input placeholder="Business name" value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} />
            <Input placeholder="Contact person" value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })} />
            <Input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <Input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <Input placeholder="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            <Input placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="sm:col-span-2" />
          </div>
          <div className="mt-4 flex gap-2">
            <Button disabled={busy} onClick={save} className="rounded-xl font-semibold">Save</Button>
            <Button variant="ghost" onClick={() => setEditingId(null)} className="rounded-xl">Cancel</Button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-sm divide-y divide-hairline">
        {suppliers.map((supplier) => (
          <div key={supplier.id} className={`flex items-center justify-between gap-3 p-4 transition-colors hover:bg-surface-sunken ${supplier.is_active ? '' : 'opacity-60'}`}>
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: nameToColor(supplier.name) }}>
                <span className="text-sm font-bold text-white/80">{supplier.name.substring(0, 2).toUpperCase()}</span>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-foreground truncate">{supplier.business_name || supplier.name}</p>
                  {!supplier.is_active && <span className="shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-semibold text-text-subtle">Inactive</span>}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  {supplier.contact_person && <span>{supplier.contact_person}</span>}
                  {supplier.phone && <span className="inline-flex items-center gap-1"><Phone size={11} /> {supplier.phone}</span>}
                  {supplier.email && <span className="inline-flex items-center gap-1"><Mail size={11} /> {supplier.email}</span>}
                  {!supplier.contact_person && !supplier.phone && !supplier.email && <span>No contact on file</span>}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="outline" className="rounded-lg" onClick={() => startEdit(supplier)}>Edit</Button>
              {!!supplier.is_active && <Button size="sm" variant="ghost" className="rounded-lg text-danger hover:bg-danger-tint hover:text-danger" onClick={() => deactivate(supplier.id)}>Deactivate</Button>}
            </div>
          </div>
        ))}
        {suppliers.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">No suppliers yet.</p>}
      </div>
    </div>
  );
}
