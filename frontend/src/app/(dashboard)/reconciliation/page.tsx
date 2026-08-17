'use client';

/**
 * Reconciliation console (SYNC-G, Part N). An owner/manager operator surface
 * over the SYNC-F/G backend: sales overview, conflict queue + detail with safe
 * resolution actions, cross-device inventory discrepancies, and sync/device
 * health. Backend authorization (`sales.reconcile`) is the source of truth —
 * this UI never relies on hiding. Not a full console; the minimal usable set.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import api from '@/lib/api';

// ── Types (mirror the /api/admin read models) ────────────────────────────────
interface SaleSummary {
  order_uid: string; order_number: string | null; channel: string | null; status: string | null;
  location_id: string | null; total: number | null; created_at: string | null;
  bill_uids: string[]; payment_status: string | null; open_conflicts: number;
}
interface Page<T> { items: T[]; total: number; limit: number; offset: number; hasMore: boolean; }
interface ConflictRow {
  conflict_uid: string; conflict_type: string; entity_type: string; entity_uid: string;
  location_id: string | null; status: string; local_snapshot_version: number | null;
  remote_snapshot_version: number | null; detected_at: string; financial_significance: 'high' | 'normal';
}
interface ConflictDetail {
  conflict: ConflictRow & { resolution_strategy: string | null; resulting_state: string | null };
  availableStrategies: string[];
  manual_action_required: boolean;
  manual_action_reason: string | null;
  local: Record<string, unknown> | null;
  remote: Record<string, unknown> | null;
  payment: { linkedPayments: number; duplicatePaymentUids: string[]; paymentsBeforeSale: number; discrepancy: boolean } | null;
  inventory: { trackedItems: number; missingMovements: number; discrepancy: boolean } | null;
  actions: Array<{ id: string; action_type: string; strategy: string | null; actor_user_id: string | null; created_at: string }>;
}
interface DiscrepancyRow {
  key: string; product_id: string; product_name: string | null; location_id: string | null;
  expected_balance: number; local_balance: number; delta: number; remote_movements: number;
  cloud_deficit: number | null; has_discrepancy: boolean;
}
interface DiscrepancyDetail extends DiscrepancyRow {
  evidence: Array<{ confidence: 'KNOWN' | 'LIKELY' | 'UNKNOWN'; kind: string; detail: string }>;
  movements: Array<{ id: string; movement_type: string; quantity_delta: number; sync_origin: string; created_at: string | null }>;
  acknowledged: boolean;
}
interface SyncHealth {
  local: { environment: string; online: boolean | null; backlog: number; failed: number; lastUploadAt: string | null; lastError: string | null; consecutiveFailures: number };
  cloud: { devices?: number; active_devices?: number; open_deficits?: number; last_received_at?: string | null } | null;
  openConflicts: number; openDeficits: number | null; thisDevice: string | null;
}

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}
function money(n: number | null | undefined): string { return n == null ? '—' : n.toFixed(2); }

export default function ReconciliationPage() {
  const [tab, setTab] = useState('sales');
  return (
    <div className="p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Reconciliation</h1>
        <p className="text-sm text-muted-foreground">Sales, cross-device conflicts, inventory discrepancies, and sync health for this organization.</p>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="sales">Sales</TabsTrigger>
          <TabsTrigger value="conflicts">Conflicts</TabsTrigger>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="health">Sync Health</TabsTrigger>
        </TabsList>
        <TabsContent value="sales"><SalesTab /></TabsContent>
        <TabsContent value="conflicts"><ConflictsTab /></TabsContent>
        <TabsContent value="inventory"><InventoryTab /></TabsContent>
        <TabsContent value="health"><HealthTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ── Sales overview ───────────────────────────────────────────────────────────
function SalesTab() {
  const [page, setPage] = useState<Page<SaleSummary> | null>(null);
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/admin/sales', { params: { q: q || undefined, limit: 20, offset } });
      setPage(res.data.data);
    } catch (err) { setError(apiError(err, 'Could not load sales')); }
    finally { setLoading(false); }
  }, [q, offset]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>Sales</CardTitle>
        <div className="flex gap-2">
          <Input placeholder="Search order / bill…" value={q} onChange={(e) => { setOffset(0); setQ(e.target.value); }} className="w-56" />
          <Button variant="outline" size="icon" onClick={load} aria-label="Refresh"><RefreshCw className="h-4 w-4" /></Button>
        </div>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {loading && !page ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {page && page.items.length === 0 && !loading ? <p className="text-sm text-muted-foreground">No sales found.</p> : null}
        {page && page.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-muted-foreground border-b">
                <th className="py-2 pr-3">Order</th><th className="pr-3">Channel</th><th className="pr-3">Status</th>
                <th className="pr-3">Payment</th><th className="pr-3 text-right">Total</th><th className="pr-3">Conflicts</th><th>When</th>
              </tr></thead>
              <tbody>
                {page.items.map((s) => (
                  <tr key={s.order_uid} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs">{s.order_number || s.order_uid.slice(-8)}</td>
                    <td className="pr-3">{s.channel || '—'}</td>
                    <td className="pr-3">{s.status || '—'}</td>
                    <td className="pr-3">{s.payment_status || '—'}</td>
                    <td className="pr-3 text-right">{money(s.total)}</td>
                    <td className="pr-3">{s.open_conflicts > 0 ? <Badge variant="destructive">{s.open_conflicts}</Badge> : <span className="text-muted-foreground">0</span>}</td>
                    <td className="text-muted-foreground text-xs">{s.created_at || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {page && (
          <div className="flex items-center justify-between pt-3 text-sm">
            <span className="text-muted-foreground">{page.total} total</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous</Button>
              <Button variant="outline" size="sm" disabled={!page.hasMore} onClick={() => setOffset(offset + 20)}>Next</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Conflict queue + detail ──────────────────────────────────────────────────
function ConflictsTab() {
  const [page, setPage] = useState<Page<ConflictRow> | null>(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/admin/conflicts', { params: { status: status || undefined, limit: 50 } });
      setPage(res.data.data);
    } catch (err) { setError(apiError(err, 'Could not load conflicts')); }
    finally { setLoading(false); }
  }, [status]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>Conflict queue</CardTitle>
        <div className="flex gap-2 items-center">
          <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
            <option value="dismissed">Dismissed</option>
          </select>
          <Button variant="outline" size="icon" onClick={load} aria-label="Refresh"><RefreshCw className="h-4 w-4" /></Button>
        </div>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {loading && !page ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {page && page.items.length === 0 && !loading ? <p className="text-sm text-muted-foreground">No conflicts — everything is reconciled.</p> : null}
        {page && page.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-muted-foreground border-b">
                <th className="py-2 pr-3">Type</th><th className="pr-3">Entity</th><th className="pr-3">Versions</th>
                <th className="pr-3">Significance</th><th className="pr-3">Status</th><th className="pr-3">Detected</th><th></th>
              </tr></thead>
              <tbody>
                {page.items.map((c) => (
                  <tr key={c.conflict_uid} className="border-b last:border-0">
                    <td className="py-2 pr-3">{c.conflict_type}</td>
                    <td className="pr-3 font-mono text-xs">{c.entity_type}:{c.entity_uid.slice(-8)}</td>
                    <td className="pr-3 text-xs">L{c.local_snapshot_version ?? '–'} / R{c.remote_snapshot_version ?? '–'}</td>
                    <td className="pr-3">{c.financial_significance === 'high' ? <Badge variant="destructive">high</Badge> : <Badge variant="secondary">normal</Badge>}</td>
                    <td className="pr-3">{c.status}</td>
                    <td className="pr-3 text-muted-foreground text-xs">{c.detected_at}</td>
                    <td><Button variant="outline" size="sm" onClick={() => setSelected(c.conflict_uid)}>Review</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      {selected && <ConflictDetailDialog conflictUid={selected} onClose={() => setSelected(null)} onChanged={load} />}
    </Card>
  );
}

function ConflictDetailDialog({ conflictUid, onClose, onChanged }: { conflictUid: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<ConflictDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [strategy, setStrategy] = useState('');
  const [notes, setNotes] = useState('');

  const load = useCallback(async () => {
    try { const res = await api.get(`/admin/conflicts/${conflictUid}`); setDetail(res.data.data); }
    catch (err) { setError(apiError(err, 'Could not load conflict')); }
  }, [conflictUid]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  async function act(path: string, body?: Record<string, unknown>) {
    setBusy(true); setError(null);
    try { await api.post(`/admin/conflicts/${conflictUid}/${path}`, body || {}); await load(); onChanged(); }
    catch (err) { setError(apiError(err, 'Action failed')); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Conflict detail</DialogTitle></DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!detail ? <p className="text-sm text-muted-foreground">Loading…</p> : (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-2 items-center">
              <Badge variant={detail.conflict.financial_significance === 'high' ? 'destructive' : 'secondary'}>{detail.conflict.conflict_type}</Badge>
              <Badge variant="outline">{detail.conflict.status}</Badge>
              <span className="font-mono text-xs text-muted-foreground">{detail.conflict.entity_type}:{detail.conflict.entity_uid}</span>
            </div>
            {detail.manual_action_required && (
              <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div><strong>Manual action required.</strong> {detail.manual_action_reason}</div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border p-3"><div className="font-medium mb-1">Local (authoritative)</div><pre className="text-xs overflow-x-auto whitespace-pre-wrap">{detail.local ? JSON.stringify(detail.local, null, 1) : 'none'}</pre></div>
              <div className="rounded-md border p-3"><div className="font-medium mb-1">Remote (mirror)</div><pre className="text-xs overflow-x-auto whitespace-pre-wrap">{detail.remote ? JSON.stringify(detail.remote, null, 1) : 'none'}</pre></div>
            </div>
            {detail.payment && (detail.payment.discrepancy || detail.payment.linkedPayments > 0) && (
              <div className="rounded-md border p-3">Payments linked: {detail.payment.linkedPayments}{detail.payment.discrepancy ? <span className="text-destructive"> — discrepancy detected</span> : ''}</div>
            )}
            {detail.inventory && detail.inventory.discrepancy && (
              <div className="rounded-md border p-3 text-destructive">Inventory discrepancy: {detail.inventory.missingMovements} missing movement(s)</div>
            )}
            <div>
              <div className="font-medium mb-1">Resolution</div>
              {detail.conflict.status === 'resolved' || detail.conflict.status === 'dismissed' ? (
                <p className="text-muted-foreground">Already {detail.conflict.status} via {detail.conflict.resolution_strategy || 'n/a'}.</p>
              ) : (
                <div className="flex flex-wrap gap-2 items-center">
                  <select className="h-9 rounded-md border border-input bg-background px-2" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
                    <option value="">Choose strategy…</option>
                    {detail.availableStrategies.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <Input placeholder="Notes / compensation reference" value={notes} onChange={(e) => setNotes(e.target.value)} className="w-64" />
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => act('acknowledge')}>Acknowledge</Button>
                  <Button size="sm" disabled={busy || !strategy} onClick={() => act('resolve', { strategy, notes, compensation_reference: notes || undefined })}>Resolve</Button>
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-1">Only legal strategies are offered. A completed sale can never be silently overwritten.</p>
            </div>
            <div>
              <div className="font-medium mb-1">Action history</div>
              {detail.actions.length === 0 ? <p className="text-muted-foreground text-xs">No actions yet.</p> : (
                <ul className="text-xs space-y-1">{detail.actions.map((a) => <li key={a.id}>{a.created_at} — {a.action_type}{a.strategy ? ` (${a.strategy})` : ''} by {a.actor_user_id || 'system'}</li>)}</ul>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Inventory discrepancies ──────────────────────────────────────────────────
function InventoryTab() {
  const [page, setPage] = useState<Page<DiscrepancyRow> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DiscrepancyDetail | null>(null);

  const load = useCallback(async () => {
    try { const res = await api.get('/admin/inventory/discrepancies', { params: { limit: 50 } }); setPage(res.data.data); }
    catch (err) { setError(apiError(err, 'Could not load discrepancies')); }
    finally { setLoading(false); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  async function open(key: string) {
    try { const res = await api.get(`/admin/inventory/discrepancies/${key}`); setDetail(res.data.data); }
    catch (err) { setError(apiError(err, 'Could not load detail')); }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Inventory discrepancies</CardTitle>
        <Button variant="outline" size="icon" onClick={load} aria-label="Refresh"><RefreshCw className="h-4 w-4" /></Button>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {loading && !page ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {page && page.items.length === 0 && !loading ? <p className="text-sm text-muted-foreground">No discrepancies — balances reconcile across devices.</p> : null}
        {page && page.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-muted-foreground border-b">
                <th className="py-2 pr-3">Product</th><th className="pr-3 text-right">Expected</th><th className="pr-3 text-right">Local</th>
                <th className="pr-3 text-right">Δ</th><th className="pr-3 text-right">Cloud deficit</th><th></th>
              </tr></thead>
              <tbody>
                {page.items.map((d) => (
                  <tr key={d.key} className="border-b last:border-0">
                    <td className="py-2 pr-3">{d.product_name || d.product_id}</td>
                    <td className="pr-3 text-right">{money(d.expected_balance)}</td>
                    <td className="pr-3 text-right">{money(d.local_balance)}</td>
                    <td className={`pr-3 text-right ${Math.abs(d.delta) > 0 ? 'text-destructive font-medium' : ''}`}>{money(d.delta)}</td>
                    <td className="pr-3 text-right">{d.cloud_deficit != null ? <span className="text-destructive">{money(d.cloud_deficit)}</span> : '—'}</td>
                    <td><Button variant="outline" size="sm" onClick={() => open(d.key)}>Evidence</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      {detail && (
        <Dialog open onOpenChange={(o) => { if (!o) setDetail(null); }}>
          <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
            <DialogHeader><DialogTitle>{detail.product_name || detail.product_id}</DialogTitle></DialogHeader>
            <div className="space-y-3 text-sm">
              <div>Expected {money(detail.expected_balance)} · Local {money(detail.local_balance)} · Δ <span className="text-destructive">{money(detail.delta)}</span></div>
              <div>
                <div className="font-medium mb-1">Evidence</div>
                {detail.evidence.length === 0 ? <p className="text-muted-foreground text-xs">No discrepancy.</p> : (
                  <ul className="space-y-1">{detail.evidence.map((e, i) => (
                    <li key={i} className="flex gap-2">
                      <Badge variant={e.confidence === 'KNOWN' ? 'destructive' : e.confidence === 'LIKELY' ? 'secondary' : 'outline'}>{e.confidence}</Badge>
                      <span className="text-xs">{e.detail}</span>
                    </li>
                  ))}</ul>
                )}
              </div>
              <p className="text-xs text-muted-foreground">Read-only analysis. Correcting stock is a deliberate manual action — nothing here mutates inventory.</p>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}

// ── Sync / device health ─────────────────────────────────────────────────────
function HealthTab() {
  const [health, setHealth] = useState<SyncHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const res = await api.get('/admin/sync-health'); setHealth(res.data.data); }
    catch (err) { setError(apiError(err, 'Could not load sync health')); }
    finally { setLoading(false); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  if (loading && !health) return <p className="text-sm text-muted-foreground p-2">Loading…</p>;
  if (error) return <p className="text-sm text-destructive p-2">{error}</p>;
  if (!health) return null;

  const online = health.local.online;
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Card>
        <CardHeader><CardTitle className="text-base">This device</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1">
          <div>Status: {online == null ? <Badge variant="secondary">no attempt</Badge> : online ? <Badge>online</Badge> : <Badge variant="destructive">failing</Badge>}</div>
          <div>Backlog: {health.local.backlog}</div>
          <div>Failed: {health.local.failed}</div>
          <div className="text-muted-foreground text-xs">Last upload: {health.local.lastUploadAt || '—'}</div>
          {health.local.lastError && <div className="text-destructive text-xs">Last error: {health.local.lastError}</div>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Organization</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1">
          {health.cloud ? (<>
            <div>Devices: {health.cloud.devices ?? '—'} ({health.cloud.active_devices ?? '—'} active)</div>
            <div>Open deficits: {health.cloud.open_deficits ?? '—'}</div>
            <div className="text-muted-foreground text-xs">Last received: {health.cloud.last_received_at || '—'}</div>
          </>) : <p className="text-muted-foreground">Cloud not reachable — showing local state only.</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Reconciliation</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1">
          <div>Open conflicts: {health.openConflicts > 0 ? <Badge variant="destructive">{health.openConflicts}</Badge> : 0}</div>
          <div>Open deficits: {health.openDeficits ?? '—'}</div>
          <Button variant="outline" size="sm" className="mt-2" onClick={load}>Refresh</Button>
        </CardContent>
      </Card>
    </div>
  );
}
