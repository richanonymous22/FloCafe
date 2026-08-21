'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChefHat } from 'lucide-react';
import api from '@/lib/api';
import { KdsLoginForm } from '@/components/kds/KdsLoginForm';
import { KdsWorkspace } from '@/components/kds/KdsWorkspace';
import { useKdsConnection } from '@/hooks/useKdsConnection';
import { useSyncServerLanguage } from '@/lib/i18n';
import type { KdsViewMode } from '@/hooks/useKdsView';

// Reads the kds_enabled setting directly (not the cached posSettings copy) so
// this route reflects the current state even if the sidebar hasn't refreshed
// its own copy yet. `null` = still loading. Never throws — a fetch failure
// falls back to "enabled" so a network hiccup doesn't lock owners out.
function useKdsEnabledCheck(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.get('/settings/kds_enabled')
      .then((res) => { if (!cancelled) setEnabled(res.data?.setting?.value !== 'false'); })
      .catch(() => { if (!cancelled) setEnabled(true); });
    return () => { cancelled = true; };
  }, []);
  return enabled;
}

// Dashboard `/kds` runs on the main API origin (port 3001), which has
// `/api/settings/kds` but not `/api/kds/info` (that one lives on the
// standalone KDS server). Fetch the default view from the main API instead
// of `useServerKdsInfo` so chef toggles reflect admin-set defaults here.
function useDashboardKdsDefault(): KdsViewMode | null {
  const [view, setView] = useState<KdsViewMode | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .get('/settings/kds')
      .then(({ data }) => {
        if (cancelled) return;
        setView(data?.kds_default_view === 'kanban' ? 'kanban' : 'tabs');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return view;
}

export default function KdsPage() {
  useSyncServerLanguage();
  const conn = useKdsConnection({ api });
  const kdsDefaultView = useDashboardKdsDefault();
  const kdsEnabled = useKdsEnabledCheck();

  if (kdsEnabled === null) {
    return (
      <div className="flex items-center justify-center h-full min-h-[60vh]">
        <div className="w-10 h-10 border-4 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (kdsEnabled === false) {
    return (
      <div className="flex h-full min-h-[60vh] items-center justify-center px-6">
        <div className="flex max-w-md flex-col items-center gap-3 rounded-2xl border border-hairline bg-surface p-10 text-center shadow-sm">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-surface-sunken text-text-subtle">
            <ChefHat size={28} />
          </div>
          <h1 className="text-lg font-bold text-foreground">Kitchen Display is disabled</h1>
          <p className="text-sm text-muted-foreground">
            This business has turned off the Kitchen Display System. An owner or manager can turn it back on from Settings.
          </p>
          <Link href="/settings?tab=kds" className="mt-2 inline-flex h-10 items-center rounded-xl bg-brand px-4 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90">
            Go to Settings
          </Link>
        </div>
      </div>
    );
  }

  if (conn.loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[60vh]">
        <div className="w-10 h-10 border-4 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!conn.user) return <KdsLoginForm conn={conn} />;
  return <KdsWorkspace conn={conn} serverDefault={kdsDefaultView} />;
}
