/**
 * Plemmo Core — FeatureService (Milestone 7, Part D-G).
 *
 * Organization → FeatureEntitlement[] → Feature. `organization_features` is
 * the single source of truth the backend actually checks; presets (§ Part
 * E) are just a convenient way to write a batch of entitlements into it —
 * applying one is not a permanent restriction, and a merchant can still
 * enable/disable individual features afterward (Part F: "Custom" is not a
 * special case, it's just what every entitlement set already is).
 *
 * `isEnabled()` is the one function that matters for backend enforcement
 * (Part G) — call it before performing an operation gated behind a
 * feature, the same way `requireRole()`/`AuthorizationService` gate a
 * permission. Never rely on the frontend to hide a disabled feature; that
 * is UX only (Part N).
 */

import { getDatabase, now } from '../db';

export class FeatureError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 403) {
    super(message);
    this.name = 'FeatureError';
    this.statusCode = statusCode;
  }
}

export interface Feature {
  key: string;
  label: string;
  category: string;
}

export interface FeaturePreset {
  id: string;
  name: string;
  description: string | null;
}

export interface OrganizationFeatureRow extends Feature {
  enabled: boolean;
  source: 'preset' | 'custom' | null;
}

export function listAllFeatures(): Feature[] {
  const db = getDatabase();
  return db.prepare('SELECT key, label, category FROM features ORDER BY category, key').all() as Feature[];
}

export function listPresets(): FeaturePreset[] {
  const db = getDatabase();
  return db.prepare('SELECT id, name, description FROM feature_presets ORDER BY name').all() as FeaturePreset[];
}

export function getPresetFeatures(presetId: string): string[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT feature_key FROM feature_preset_items WHERE preset_id = ?').all(presetId) as { feature_key: string }[];
  return rows.map((row) => row.feature_key);
}

/**
 * Every feature in the catalog, with this organization's current
 * enabled/disabled state — the shape a future Admin Panel's feature
 * toggle list needs directly, no client-side joining required.
 */
export function listOrganizationFeatures(organizationId: string): OrganizationFeatureRow[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT f.key, f.label, f.category,
      COALESCE(of2.enabled, 0) as enabled, of2.source as source
    FROM features f
    LEFT JOIN organization_features of2 ON of2.organization_id = ? AND of2.feature_key = f.key
    ORDER BY f.category, f.key
  `).all(organizationId).map((row: any) => ({ ...row, enabled: !!row.enabled })) as OrganizationFeatureRow[];
}

/**
 * The one function backend enforcement calls (Part G). An organization
 * with no row at all for a feature is treated as NOT entitled — the safe
 * default for a feature nobody has explicitly granted, rather than
 * silently allowing anything unconfigured.
 */
export function isEnabled(organizationId: string, featureKey: string): boolean {
  const db = getDatabase();
  const row = db.prepare('SELECT enabled FROM organization_features WHERE organization_id = ? AND feature_key = ?')
    .get(organizationId, featureKey) as { enabled: number } | undefined;
  return !!row?.enabled;
}

/** Throws — for a Core/route call site that must fail the operation outright, not just branch on it. */
export function requireEnabled(organizationId: string, featureKey: string): void {
  if (!isEnabled(organizationId, featureKey)) {
    throw new FeatureError(`Feature '${featureKey}' is not enabled for this organization`);
  }
}

function requireKnownFeature(db: ReturnType<typeof getDatabase>, featureKey: string): void {
  const row = db.prepare('SELECT 1 FROM features WHERE key = ?').get(featureKey);
  if (!row) throw new FeatureError(`Unknown feature '${featureKey}'`, 400);
}

export function grantFeature(organizationId: string, featureKey: string): void {
  const db = getDatabase();
  requireKnownFeature(db, featureKey);
  db.prepare(`
    INSERT INTO organization_features (organization_id, feature_key, enabled, source, updated_at)
    VALUES (?, ?, 1, 'custom', ?)
    ON CONFLICT(organization_id, feature_key) DO UPDATE SET enabled = 1, source = 'custom', updated_at = excluded.updated_at
  `).run(organizationId, featureKey, now());
}

export function revokeFeature(organizationId: string, featureKey: string): void {
  const db = getDatabase();
  requireKnownFeature(db, featureKey);
  db.prepare(`
    INSERT INTO organization_features (organization_id, feature_key, enabled, source, updated_at)
    VALUES (?, ?, 0, 'custom', ?)
    ON CONFLICT(organization_id, feature_key) DO UPDATE SET enabled = 0, source = 'custom', updated_at = excluded.updated_at
  `).run(organizationId, featureKey, now());
}

/**
 * Replaces this organization's entire entitlement set with exactly the
 * preset's features (everything else disabled) — a clean "start from this
 * preset" operation, not an additive grant. `source = 'preset'` on every
 * resulting row, so `setCustomFeatures()`/individual grant-revoke calls
 * afterward are visibly a deliberate customization away from the preset.
 */
export function applyPreset(organizationId: string, presetId: string): void {
  const db = getDatabase();
  const preset = db.prepare('SELECT id FROM feature_presets WHERE id = ?').get(presetId);
  if (!preset) throw new FeatureError(`Unknown preset '${presetId}'`, 400);
  const presetFeatures = new Set(getPresetFeatures(presetId));
  const allFeatures = listAllFeatures();
  const timestamp = now();
  const upsert = db.prepare(`
    INSERT INTO organization_features (organization_id, feature_key, enabled, source, updated_at)
    VALUES (?, ?, ?, 'preset', ?)
    ON CONFLICT(organization_id, feature_key) DO UPDATE SET enabled = excluded.enabled, source = 'preset', updated_at = excluded.updated_at
  `);
  db.transaction(() => {
    for (const feature of allFeatures) {
      upsert.run(organizationId, feature.key, presetFeatures.has(feature.key) ? 1 : 0, timestamp);
    }
  })();
}

/**
 * Sets this organization's entitlement set to exactly the given feature
 * keys (everything else disabled), `source = 'custom'` — the "Preset =
 * Custom, manually enable/disable" case (Part F).
 */
export function setCustomFeatures(organizationId: string, featureKeys: string[]): void {
  const db = getDatabase();
  const known = new Set(listAllFeatures().map((f) => f.key));
  for (const key of featureKeys) {
    if (!known.has(key)) throw new FeatureError(`Unknown feature '${key}'`, 400);
  }
  const enabledSet = new Set(featureKeys);
  const timestamp = now();
  const upsert = db.prepare(`
    INSERT INTO organization_features (organization_id, feature_key, enabled, source, updated_at)
    VALUES (?, ?, ?, 'custom', ?)
    ON CONFLICT(organization_id, feature_key) DO UPDATE SET enabled = excluded.enabled, source = 'custom', updated_at = excluded.updated_at
  `);
  db.transaction(() => {
    for (const feature of listAllFeatures()) {
      upsert.run(organizationId, feature.key, enabledSet.has(feature.key) ? 1 : 0, timestamp);
    }
  })();
}
