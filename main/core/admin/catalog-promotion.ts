/**
 * Plemmo Admin — controlled remote-catalog promotion (PLATFORM-HARDENING, Part C).
 *
 * Remote reference data lands in the `remote_reference_entities` MIRROR (never
 * the authoritative catalog). Promotion is the EXPLICIT, authorized step that
 * materializes a mirrored record into the local authoritative catalog — safely:
 *
 *   mirror → validation → authorization → explicit promotion → audit → lineage
 *
 * Safety rules (the whole point of this being a controlled step):
 *   - Only reference/catalog types are promotable (product, category,
 *     product_variant, addon_group, addon, customer, supplier). Operational
 *     state (order/bill/PO/transfer) is NEVER promoted — it stays in review.
 *   - Identity is the stable ULID, so promotion is idempotent and can never
 *     DUPLICATE a local record.
 *   - INSERT-IF-ABSENT only: if the authoritative row does not exist locally,
 *     it is created from the mirror payload (a genuinely new remote record
 *     appearing). If it ALREADY exists locally, promotion does NOT overwrite it
 *     — it returns `review_required`, protecting a local edit. No blind
 *     last-write-wins over meaningful business configuration; no destruction of
 *     local catalog history.
 *   - Only real columns of the target table are written (PRAGMA-whitelisted),
 *     so an unexpected payload field can never inject a column.
 *   - Audited; the promoted row keeps its ULID lineage.
 */

import type Database from 'better-sqlite3';
import { getDatabase, withTxn, now } from '../../db';
import { requireCan, AuthUser } from '../authorization';
import { recordAuditEvent } from '../audit';
import { recordReconciliationAction } from '../sync/conflict-store';

/** Promotable reference types → authoritative table. Operational state excluded. */
const PROMOTABLE: Record<string, string> = {
  product: 'products',
  category: 'categories',
  product_variant: 'product_variants',
  addon_group: 'addon_groups',
  addon: 'addons',
  customer: 'customers',
  supplier: 'suppliers',
};

export class PromotionError extends Error {
  statusCode = 400;
  constructor(message: string, statusCode = 400) { super(message); this.name = 'PromotionError'; this.statusCode = statusCode; }
}

export type PromotionOutcome = 'promoted' | 'review_required' | 'not_promotable';

export interface PromotionResult {
  outcome: PromotionOutcome;
  entity_type: string;
  uid: string;
  reason?: string;
}

export interface PromoteInput {
  entityType: string;
  uid: string;
  user: AuthUser;
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Promotes a mirrored reference record into the authoritative catalog when it
 * is safe to do so. INSERT-IF-ABSENT; an existing local row is protected
 * (`review_required`). Never overwrites, never duplicates, never deletes.
 */
export function promoteRemoteEntity(input: PromoteInput): PromotionResult {
  return withTxn(() => {
    const db = getDatabase();
    // Authorization: promotion is an owner/manager capability (same trust level
    // as reconciliation). Not client-hideable.
    requireCan(input.user, 'sales.reconcile');

    const table = PROMOTABLE[input.entityType];
    if (!table) return { outcome: 'not_promotable', entity_type: input.entityType, uid: input.uid, reason: 'operational/financial entities are not promoted; they stay in review' };

    const mirror = db.prepare('SELECT payload FROM remote_reference_entities WHERE entity_type = ? AND uid = ?').get(input.entityType, input.uid) as { payload: string } | undefined;
    if (!mirror) throw new PromotionError(`no mirrored ${input.entityType} ${input.uid} to promote`, 404);

    let fields: Record<string, unknown>;
    try { fields = (JSON.parse(mirror.payload) as { fields?: Record<string, unknown> }).fields ?? {}; } catch { throw new PromotionError('mirror payload is malformed', 422); }
    if (!fields.id) fields.id = input.uid;

    // Protect a local edit: never overwrite an existing authoritative row.
    const existing = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(input.uid);
    if (existing) {
      recordReconciliationAction({
        entityType: input.entityType, entityUid: input.uid, actionType: 'reconciliation',
        actorUserId: input.user.userId, actorRole: input.user.role,
        notes: 'promotion skipped — a local authoritative record already exists (protected from overwrite)',
      }, db);
      return { outcome: 'review_required', entity_type: input.entityType, uid: input.uid, reason: 'a local authoritative record already exists; promotion will not overwrite it' };
    }

    // INSERT only the real columns of the target table (PRAGMA-whitelisted).
    const cols = tableColumns(db, table);
    const entries = Object.entries(fields).filter(([k]) => cols.has(k));
    if (!entries.some(([k]) => k === 'id')) entries.push(['id', input.uid]);
    const columnNames = entries.map(([k]) => k);
    const placeholders = entries.map(() => '?').join(', ');
    const values = entries.map(([, v]) => (v === undefined ? null : (typeof v === 'object' && v !== null ? JSON.stringify(v) : v)));
    db.prepare(`INSERT INTO ${table} (${columnNames.join(', ')}) VALUES (${placeholders})`).run(...values);

    recordReconciliationAction({
      entityType: input.entityType, entityUid: input.uid, actionType: 'reconciliation',
      actorUserId: input.user.userId, actorRole: input.user.role, notes: 'promoted remote reference record into the authoritative catalog',
    }, db);
    recordAuditEvent({
      type: 'sync.reconciliation_recorded', actor: { userId: input.user.userId, role: input.user.role },
      entity: { type: input.entityType, id: input.uid },
      summary: `Promoted remote ${input.entityType} ${input.uid} into the authoritative catalog`,
      metadata: { entity_type: input.entityType, uid: input.uid, promoted_at: now() },
    });
    return { outcome: 'promoted', entity_type: input.entityType, uid: input.uid };
  });
}

/** Lists mirrored reference records available for promotion (operator review). */
export function listPromotable(entityType: string | undefined, db: Database.Database = getDatabase()): Array<Record<string, unknown>> {
  const rows = entityType
    ? db.prepare('SELECT entity_type, uid, snapshot_version, updated_at, applied_at FROM remote_reference_entities WHERE entity_type = ? ORDER BY applied_at DESC LIMIT 500').all(entityType)
    : db.prepare('SELECT entity_type, uid, snapshot_version, updated_at, applied_at FROM remote_reference_entities ORDER BY applied_at DESC LIMIT 500').all();
  return rows as Array<Record<string, unknown>>;
}
