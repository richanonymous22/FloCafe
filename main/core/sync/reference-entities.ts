/**
 * Plemmo Core — reference / operational entity sync (COMMERCIALIZATION,
 * Parts C/D/E/F/G).
 *
 * Catalog (product / category / product_variant / addon_group / addon),
 * customers, suppliers, and operations (purchase_order / purchase_order_item /
 * stock_transfer / stock_transfer_item) all share ONE property that makes them
 * far lower-risk than sales: their business identity is a stable ULID primary
 * key. So they synchronize through the EXISTING mutable-snapshot seam (SYNC-E)
 * with a uniform per-entity policy:
 *
 *   - Source of truth: the LOCAL authoritative row (unchanged).
 *   - Conflict class: `reference_snapshot` — a versioned mutable snapshot.
 *     Cross-device divergence is recorded (informational) but is NEVER a
 *     blocking financial conflict; the highest snapshot_version is the current
 *     read-model value.
 *   - Remote apply: idempotent by (entity_type, uid) into a single generic
 *     MIRROR table (`remote_reference_entities`) — NEVER the authoritative
 *     catalog/customer/supplier tables. Promotion of a remote reference record
 *     into the local authoritative catalog is a controlled Admin/merge step
 *     (future), not an automatic sync mutation. This preserves the local
 *     authoritative model and cannot duplicate a local record (ULID identity).
 *   - Idempotency: a re-uploaded identical snapshot dedupes by event_uid; a
 *     re-pulled snapshot dedupes by (entity_type, uid) at the mirror.
 *
 * The emitter reads the authoritative row and snapshots its business fields
 * verbatim (these tables hold no secrets), so a new reference column is synced
 * automatically. Emission is best-effort (never throws) so it can never break
 * a catalog/customer write — a reference snapshot is not financially atomic the
 * way a sale is (sales emitters stay strict; these do not).
 */

import type Database from 'better-sqlite3';
import { getDatabase } from '../../db';
import { getOrganizationContext, getLocationContext } from '../context';
import { appendSnapshotOutboxEvent, OutboxRow } from './outbox';
import { SyncEntityType, ReferenceEntityPayload } from './types';

type Db = Database.Database;

/** Maps each reference entity type to its authoritative table + optional location column. */
interface EntitySpec { table: string; locationColumn?: string; }
export const REFERENCE_ENTITY_SPECS: Record<string, EntitySpec> = {
  product: { table: 'products' },
  category: { table: 'categories' },
  product_variant: { table: 'product_variants' },
  addon_group: { table: 'addon_groups' },
  addon: { table: 'addons' },
  customer: { table: 'customers' },
  supplier: { table: 'suppliers' },
  purchase_order: { table: 'purchase_orders', locationColumn: 'location_id' },
  purchase_order_item: { table: 'purchase_order_items' },
  stock_transfer: { table: 'stock_transfers', locationColumn: 'from_location_id' },
  stock_transfer_item: { table: 'stock_transfer_items' },
};

/** The conflict policy for a reference entity (COMMERCIALIZATION Part G). */
export interface ReferenceConflictPolicy {
  sourceOfTruth: 'local_authoritative';
  conflictClass: 'reference_snapshot';
  mutation: 'versioned_snapshot';
  legalResolution: string;
  remoteApply: 'mirror_only';
  idempotency: 'ulid_identity';
}
export const REFERENCE_CONFLICT_POLICY: ReferenceConflictPolicy = {
  sourceOfTruth: 'local_authoritative',
  conflictClass: 'reference_snapshot',
  mutation: 'versioned_snapshot',
  legalResolution: 'accept_highest_version (non-financial, last-write-wins-safe); recorded but non-blocking',
  remoteApply: 'mirror_only',
  idempotency: 'ulid_identity',
};

function isReferenceType(t: SyncEntityType): t is keyof typeof REFERENCE_ENTITY_SPECS & SyncEntityType {
  return Object.prototype.hasOwnProperty.call(REFERENCE_ENTITY_SPECS, t);
}

/**
 * Emits a versioned snapshot of a reference entity by its ULID id. Best-effort:
 * a missing row, a missing spec, or any error returns null without throwing, so
 * a catalog/customer write is never broken by sync.
 */
export function appendReferenceSnapshot(db: Db, entityType: SyncEntityType, id: string): OutboxRow | null {
  try {
    if (!isReferenceType(entityType) || !id) return null;
    const spec = REFERENCE_ENTITY_SPECS[entityType];
    const row = db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const organizationId = (row.organization_id as string | null | undefined) ?? getOrganizationContext()?.id ?? null;
    const locationId = spec.locationColumn
      ? ((row[spec.locationColumn] as string | null | undefined) ?? null)
      : (getLocationContext()?.id ?? null);
    return appendSnapshotOutboxEvent({
      db, entityType, entityUid: id, organizationId, locationId,
      buildPayload: (snapshot_version): ReferenceEntityPayload => ({
        schema_version: 1, entity_type: entityType, entity_uid: id,
        organization_id: organizationId, location_id: locationId, snapshot_version,
        updated_at: (row.updated_at as string | null | undefined) ?? null,
        fields: row,
      }),
    });
  } catch {
    return null; // best-effort — never break a reference-data write
  }
}

/** Convenience wrappers (clear call sites at the write paths). */
export const snapshotProduct = (db: Db, id: string) => appendReferenceSnapshot(db, 'product', id);
export const snapshotProductVariant = (db: Db, id: string) => appendReferenceSnapshot(db, 'product_variant', id);
export const snapshotCategory = (db: Db, id: string) => appendReferenceSnapshot(db, 'category', id);
export const snapshotAddonGroup = (db: Db, id: string) => appendReferenceSnapshot(db, 'addon_group', id);
export const snapshotAddon = (db: Db, id: string) => appendReferenceSnapshot(db, 'addon', id);
export const snapshotCustomer = (db: Db, id: string) => appendReferenceSnapshot(db, 'customer', id);
export const snapshotSupplier = (db: Db, id: string) => appendReferenceSnapshot(db, 'supplier', id);
export const snapshotPurchaseOrder = (db: Db, id: string) => appendReferenceSnapshot(db, 'purchase_order', id);
export const snapshotStockTransfer = (db: Db, id: string) => appendReferenceSnapshot(db, 'stock_transfer', id);

export function snapshotEntity(entityType: SyncEntityType, id: string, db: Db = getDatabase()): OutboxRow | null {
  return appendReferenceSnapshot(db, entityType, id);
}
