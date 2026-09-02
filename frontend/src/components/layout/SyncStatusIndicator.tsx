'use client';

/**
 * Connection / sync / license status cluster (docs/DESIGN_SYSTEM.md —
 * "Offline / sync / license status"). Every role sees this in the topbar so a
 * transaction's save state is never ambiguous: local save is immediate and
 * independent of sync; this only reports whether the device has caught the
 * cloud up. Backed by GET /api/sync/status (any authenticated role).
 */

import { useCallback, useEffect, useState } from 'react';
import { CloudOff, RefreshCw, CloudAlert, ShieldAlert } from 'lucide-react';
import api from '@/lib/api';
import { StatusPill } from '@/components/ui/status-pill';

interface SyncStatus {
  enabled: boolean;
  online: boolean | null;
  pending: number;
  failed: number;
  lastUploadAt: string | null;
  lastDownloadAt: string | null;
  consecutiveFailures: number;
  license: { status: string; plan: string };
}

const POLL_MS = 15000;

export default function SyncStatusIndicator() {
  const [status, setStatus] = useState<SyncStatus | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/sync/status');
      setStatus(res.data);
    } catch {
      // Network/API unreachable is itself an offline signal — represent it as such.
      setStatus((prev) => (prev ? { ...prev, online: false } : prev));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  if (!status || !status.enabled) return null; // sync not configured — nothing to report

  const licenseBlocked = status.license.status === 'revoked' || status.license.status === 'expired';
  const licenseGrace = status.license.status === 'grace' || status.license.status === 'needs_verification';
  const syncFailing = status.consecutiveFailures > 0 || status.failed > 0;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {licenseBlocked && (
        <StatusPill tone="danger" title="Licence requires attention">
          <ShieldAlert className="size-3" />
          Licence
        </StatusPill>
      )}
      {!licenseBlocked && licenseGrace && (
        <StatusPill tone="warning" title="Licence in grace period — reconnect to verify">
          <ShieldAlert className="size-3" />
          Licence grace
        </StatusPill>
      )}

      {status.online === false ? (
        <StatusPill tone="warning" title="Working offline — sales save locally and will sync when reconnected">
          <CloudOff className="size-3" />
          Offline
        </StatusPill>
      ) : syncFailing ? (
        <StatusPill tone="danger" title={`Sync failing (${status.consecutiveFailures} attempt(s))`}>
          <CloudAlert className="size-3" />
          Sync failed
        </StatusPill>
      ) : status.pending > 0 ? (
        <StatusPill tone="info" title={`${status.pending} change(s) syncing`}>
          <RefreshCw className="size-3" />
          Syncing {status.pending}
        </StatusPill>
      ) : (
        <StatusPill tone="success" title="Online and synced">
          Online
        </StatusPill>
      )}
    </div>
  );
}
