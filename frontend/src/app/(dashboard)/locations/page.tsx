'use client';

/**
 * Location management (Milestone 6, Part Q). Deliberately minimal — list
 * locations, create a new one, and show this install's own device/
 * register/location/organization context. Does not let this install
 * switch which location it represents (Part K).
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
      <h1 className="text-2xl font-semibold">Locations</h1>
      {error && <div className="text-destructive text-sm">{error}</div>}

      <Card>
        <CardHeader><CardTitle className="text-base">This device</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1">
          <div>Organization: {context?.organization?.name || '—'}</div>
          <div>Location: {context?.location?.name || '—'}</div>
          <div>Register: {context?.register?.name || '—'}</div>
          <div>Device: {context?.device?.name || '—'}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Add a location</CardTitle></CardHeader>
        <CardContent className="flex gap-2">
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} className="max-w-32" />
          <Button disabled={busy} onClick={createLocation}>Add</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">All locations</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          {locations.map((l) => (
            <div key={l.id} className="flex justify-between text-sm border-b pb-1 last:border-0">
              <span>{l.name}{l.code ? ` (${l.code})` : ''}</span>
              <span className="text-muted-foreground">{l.is_active ? 'Active' : 'Inactive'}</span>
            </div>
          ))}
          {locations.length === 0 && <p className="text-muted-foreground text-sm">No locations yet.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
