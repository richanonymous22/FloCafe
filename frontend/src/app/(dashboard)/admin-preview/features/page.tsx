'use client';

/**
 * Feature entitlement preview (Milestone 7, Part K). A development/preview
 * screen for the feature model, NOT the real Plemmo Admin — that is a
 * later milestone. Owner only.
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import api from '@/lib/api';

interface FeatureRow { key: string; label: string; category: string; enabled: boolean; source: string | null; }
interface Preset { id: string; name: string; description: string | null; }

function errorMessage(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return message || fallback;
}

export default function FeaturesPreviewPage() {
  const [features, setFeatures] = useState<FeatureRow[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/features')
      .then((res) => { setFeatures(res.data.features); setPresets(res.data.presets); })
      .catch((err) => setError(errorMessage(err, 'Could not load features')));
  }, []);

  async function refresh() {
    const res = await api.get('/features');
    setFeatures(res.data.features);
  }

  async function toggle(feature: FeatureRow) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/features/${feature.key}/${feature.enabled ? 'revoke' : 'grant'}`);
      await refresh();
    } catch (err) {
      setError(errorMessage(err, 'Could not update feature'));
    } finally {
      setBusy(false);
    }
  }

  async function applyPreset(presetId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post('/features/apply-preset', { preset_id: presetId });
      await refresh();
    } catch (err) {
      setError(errorMessage(err, 'Could not apply preset'));
    } finally {
      setBusy(false);
    }
  }

  const byCategory = features.reduce<Record<string, FeatureRow[]>>((acc, feature) => {
    (acc[feature.category] ||= []).push(feature);
    return acc;
  }, {});

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Feature entitlements <span className="text-text-subtle">(preview)</span></h1>
        <p className="mt-0.5 text-sm text-text-subtle">
          Development preview of the feature model — not the final Plemmo Admin.
        </p>
      </div>
      {error && <div className="text-destructive text-sm">{error}</div>}

      <Card>
        <CardHeader><CardTitle className="text-base">Presets</CardTitle></CardHeader>
        <CardContent className="flex gap-2">
          {presets.map((preset) => (
            <Button key={preset.id} variant="outline" disabled={busy} onClick={() => applyPreset(preset.id)}>
              Apply {preset.name}
            </Button>
          ))}
        </CardContent>
      </Card>

      {Object.entries(byCategory).map(([category, rows]) => (
        <Card key={category}>
          <CardHeader><CardTitle className="text-base capitalize">{category}</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {rows.map((feature) => (
              <div key={feature.key} className="flex items-center justify-between text-sm border-b pb-1 last:border-0">
                <span>{feature.label} <span className="text-muted-foreground">({feature.key})</span></span>
                <Button size="sm" variant={feature.enabled ? 'secondary' : 'outline'} disabled={busy} onClick={() => toggle(feature)}>
                  {feature.enabled ? 'Enabled' : 'Disabled'}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
