'use client';

/**
 * Location management (Milestone 6, Part Q). Deliberately minimal — list
 * locations, create a new one, and show this install's own device/
 * register/location/organization context. Does not let this install
 * switch which location it represents (Part K).
 */

import { useEffect, useState } from 'react';
import { Plus, Store, Building2, Monitor, Cpu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { nameToColor } from '@/lib/image-utils';
import api from '@/lib/api';

interface Location { id: string; name: string; code: string | null; is_active: number; }
interface ContextInfo {
  organization: { id: string; name: string } | null;
  location: { id: string; name: string } | null;
  register: { id: string; name: string } | null;
  device: { id: string; name: string | null } | null;
}

function errorMessage(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return message || fallback;
}

export default function LocationsPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [context, setContext] = useState<ContextInfo | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.get('/locations'), api.get('/locations/context')])
      .then(([locRes, ctxRes]) => { setLocations(locRes.data.locations); setContext(ctxRes.data); })
      .catch((err) => setError(errorMessage(err, 'Could not load locations')));
  }, []);

  async function createLocation() {
    if (!name.trim()) { setError('Name is required'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post('/locations', { name: name.trim(), code: code.trim() || undefined });
      setName('');
      setCode('');
      const res = await api.get('/locations');
      setLocations(res.data.locations);
    } catch (err) {
      setError(errorMessage(err, 'Could not create location'));
    } finally {
      setBusy(false);
    }
  }

  const contextRows = [
    { icon: Building2, label: 'Organization', value: context?.organization?.name },
    { icon: Store, label: 'Location', value: context?.location?.name },
    { icon: Monitor, label: 'Register', value: context?.register?.name },
    { icon: Cpu, label: 'Device', value: context?.device?.name },
  ];

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-5">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Locations</h1>
        <p className="mt-0.5 text-sm text-text-subtle">The sites you trade from, and what this device is registered as.</p>
      </div>

      {error && <div className="rounded-lg border border-destructive/30 bg-danger-tint px-4 py-3 text-sm text-destructive">{error}</div>}

      {/* This device context */}
      <div className="rounded-2xl border border-hairline bg-surface p-5 shadow-sm">
        <h2 className="mb-4 text-[11px] font-bold uppercase tracking-wide text-text-subtle">This device</h2>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {contextRows.map(({ icon: Icon, label, value }) => (
            <div key={label} className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-primary"><Icon size={18} /></div>
              <div className="min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-wide text-text-subtle">{label}</p>
                <p className="truncate text-sm font-semibold text-foreground">{value || '—'}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Add a location */}
      <div className="rounded-2xl border border-hairline bg-surface p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-bold text-foreground">Add a location</h2>
        <div className="flex flex-wrap gap-2">
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} className="h-10 flex-1 rounded-xl border-hairline" />
          <Input placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} className="h-10 w-32 rounded-xl border-hairline" />
          <Button disabled={busy} onClick={createLocation} className="h-10 gap-2 rounded-xl font-semibold"><Plus size={16} /> Add</Button>
        </div>
      </div>

      {/* All locations */}
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-sm">
        <div className="border-b border-hairline px-5 py-3"><h2 className="text-sm font-bold text-foreground">All locations</h2></div>
        <div className="divide-y divide-hairline">
          {locations.map((l) => (
            <div key={l.id} className={`flex items-center justify-between gap-3 p-4 ${l.is_active ? '' : 'opacity-60'}`}>
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: nameToColor(l.name) }}>
                  <span className="text-sm font-bold text-white/80">{l.name.substring(0, 2).toUpperCase()}</span>
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-foreground truncate">{l.name}</p>
                  {l.code && <p className="text-xs text-muted-foreground">Code: {l.code}</p>}
                </div>
              </div>
              <span className={`shrink-0 inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${l.is_active ? 'bg-success-tint text-success' : 'bg-surface-sunken text-text-subtle'}`}>
                {l.is_active ? 'Active' : 'Inactive'}
              </span>
            </div>
          ))}
          {locations.length === 0 && <p className="px-5 py-10 text-center text-sm text-muted-foreground">No locations yet.</p>}
        </div>
      </div>
    </div>
  );
}
