'use client';

/**
 * Supplier management (Milestone 5, Part K). Deliberately minimal — list,
 * search, create/edit, deactivate. No purchasing here; that's /purchasing.
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import api from '@/lib/api';

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

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Suppliers</h1>
        <Button onClick={startCreate}>New supplier</Button>
      </div>

      <div className="flex gap-2">
        <Input
          placeholder="Search suppliers"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(search); }}
        />
        <Button variant="outline" onClick={() => load(search)}>Search</Button>
      </div>

      {error && <div className="text-destructive text-sm">{error}</div>}

      {editingId && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{editingId === 'new' ? 'New supplier' : 'Edit supplier'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Input placeholder="Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input placeholder="Business name" value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} />
            <Input placeholder="Contact person" value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })} />
            <Input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <Input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <Input placeholder="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            <Input placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            <div className="flex gap-2">
              <Button disabled={busy} onClick={save}>Save</Button>
              <Button variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {suppliers.map((supplier) => (
          <Card key={supplier.id}>
            <CardContent className="pt-6 flex items-center justify-between">
              <div>
                <div className="font-medium">{supplier.name}{!supplier.is_active && <span className="text-muted-foreground text-sm"> (inactive)</span>}</div>
                <div className="text-sm text-muted-foreground">
                  {[supplier.contact_person, supplier.phone, supplier.email].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => startEdit(supplier)}>Edit</Button>
                {!!supplier.is_active && <Button size="sm" variant="ghost" onClick={() => deactivate(supplier.id)}>Deactivate</Button>}
              </div>
            </CardContent>
          </Card>
        ))}
        {suppliers.length === 0 && <p className="text-muted-foreground text-sm">No suppliers yet.</p>}
      </div>
    </div>
  );
}
