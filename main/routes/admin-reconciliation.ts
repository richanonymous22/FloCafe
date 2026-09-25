/**
 * Plemmo API — Admin sales/reconciliation console (SYNC-G, Part O).
 *
 * The operator-facing read + safe-action API consumed by the Reconciliation
 * dashboard. Every route is gated by `requirePermission('sales.reconcile')`
 * (owner/manager) — the canonical Milestone 8 path — and every read model is
 * organization-scoped from the authenticated server context, never from the
 * client. Backend authorization is the source of truth; the UI never relies on
 * hiding.
 *
 * The cloud half (organization health, cross-device deficits) is fetched
 * best-effort over the org-scoped `GET /sync/v1/health` / `/sync/v1/deficits`
 * endpoints; when sync is disabled or the cloud is unreachable the local half
 * is still returned with the cloud fields null.
 */

import { Router, Request, Response } from 'express';
import { requirePermission } from '../middleware/authorize';
import { AuthUser, AuthorizationError } from '../core/authorization';
import { getOrganizationContext } from '../core/context';
import { getDatabase } from '../db';
import { listSales, orderDetail, billDetail } from '../core/admin/sales-overview';
import { conflictQueue, conflictDetail } from '../core/admin/conflict-console';
import { listDiscrepancies, discrepancyDetail } from '../core/admin/inventory-reconciliation';
import { operatorSyncHealth, deviceHealth } from '../core/admin/sync-health';
import {
  acknowledgeConflict, resolveConflict,
  ConflictNotFoundError, ConflictStateError, IllegalResolutionError,
} from '../core/sync/conflict-resolution';
import { recordReconciliationAction } from '../core/sync/conflict-store';
import { recordAuditEvent } from '../core/audit';
import { getSyncCloudConfig } from '../core/sync/config';
import { HttpSyncTransport } from '../core/sync/http-transport';
import { executeCompensation, executeInventoryCorrection, CompensationError } from '../core/admin/compensation';
import { getLicense, effectiveStatus, activateLicense, isFeatureLicensed, License } from '../core/licensing';
import { LicenseError } from '../core/licensing';
import { promoteRemoteEntity, listPromotable, PromotionError } from '../core/admin/catalog-promotion';

const router = Router();

function userOf(req: Request): AuthUser {
  const u = (req as any).user;
  return { userId: String(u?.userId ?? u?.id ?? ''), role: String(u?.role ?? '') };
}
function orgId(): string { return getOrganizationContext()?.id ?? ''; }

function handle(res: Response, fn: () => unknown, okStatus = 200): void {
  try {
    res.status(okStatus).json({ data: fn() });
  } catch (error) {
    const e = error as Error & { statusCode?: number };
    if (e instanceof AuthorizationError || e instanceof ConflictNotFoundError || e instanceof ConflictStateError || e instanceof IllegalResolutionError
        || e instanceof CompensationError || e instanceof LicenseError || e instanceof PromotionError) {
      res.status(e.statusCode ?? 400).json({ error: e.message, code: e.name });
      return;
    }
    res.status(500).json({ error: e.message });
  }
}
async function handleAsync(res: Response, fn: () => Promise<unknown>, okStatus = 200): Promise<void> {
  try { res.status(okStatus).json({ data: await fn() }); }
  catch (error) { res.status(500).json({ error: (error as Error).message }); }
}

/** Best-effort cloud health fetch; null when sync is off or unreachable. */
async function fetchCloudHealth(): Promise<Record<string, unknown> | null> {
  const cfg = getSyncCloudConfig();
  if (!cfg.enabled || !cfg.baseUrl) return null;
  try { return await new HttpSyncTransport({ baseUrl: cfg.baseUrl }).pullHealth(); } catch { return null; }
}
async function fetchCloudDeficits(): Promise<Array<Record<string, unknown>>> {
  const cfg = getSyncCloudConfig();
  if (!cfg.enabled || !cfg.baseUrl) return [];
  try { return await new HttpSyncTransport({ baseUrl: cfg.baseUrl }).pullDeficits(); } catch { return []; }
}

// ── Sales overview ───────────────────────────────────────────────────────────
router.get('/sales', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => listSales({
    organizationId: orgId(),
    q: req.query.q as string | undefined,
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
    locationId: req.query.location_id as string | undefined,
    status: req.query.status as string | undefined,
    paymentStatus: req.query.payment_status as string | undefined,
    conflictStatus: req.query.conflicts === 'true' ? 'with_conflicts' : 'any',
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    offset: req.query.offset ? Number(req.query.offset) : undefined,
  }));
});
router.get('/sales/order/:uid', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => orderDetail(String(req.params.uid)));
});
router.get('/sales/bill/:uid', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => billDetail(String(req.params.uid)));
});

// ── Conflict queue + detail + safe actions ───────────────────────────────────
router.get('/conflicts', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => conflictQueue({
    organizationId: orgId(),
    status: req.query.status as any,
    conflictType: req.query.type as string | undefined,
    locationId: req.query.location_id as string | undefined,
    significance: req.query.significance as any,
    sort: (req.query.sort as any) ?? 'newest',
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    offset: req.query.offset ? Number(req.query.offset) : undefined,
  }));
});
router.get('/conflicts/:uid', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => {
    const detail = conflictDetail(String(req.params.uid));
    if (!detail) throw new ConflictNotFoundError(String(req.params.uid));
    return detail;
  });
});
router.post('/conflicts/:uid/acknowledge', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => ({ conflict: acknowledgeConflict({ conflictUid: String(req.params.uid), user: userOf(req), notes: (req.body || {}).notes ?? null }) }));
});
router.post('/conflicts/:uid/resolve', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => {
    const body = req.body || {};
    return { conflict: resolveConflict({ conflictUid: String(req.params.uid), strategy: String(body.strategy ?? ''), user: userOf(req), notes: body.notes ?? null, compensationReference: body.compensation_reference ?? null }) };
  });
});

// ── Inventory discrepancies (read-only detection; acknowledge records a decision) ──
router.get('/inventory/discrepancies', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handleAsync(res, async () => {
    const deficits = await fetchCloudDeficits();
    return listDiscrepancies({
      organizationId: orgId(),
      locationId: req.query.location_id as string | undefined,
      onlyDiscrepancies: req.query.all !== 'true',
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    }, deficits as any);
  });
});
router.get('/inventory/discrepancies/:key', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handleAsync(res, async () => {
    const deficits = await fetchCloudDeficits();
    const detail = discrepancyDetail(String(req.params.key), deficits as any);
    if (!detail) return { error: 'not found' };
    return detail;
  });
});
router.post('/inventory/discrepancies/:key/acknowledge', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => {
    const user = userOf(req);
    const key = String(req.params.key);
    const action = recordReconciliationAction({
      entityType: 'inventory_discrepancy', entityUid: key, organizationId: orgId(),
      actionType: 'acknowledge', actorUserId: user.userId, actorRole: user.role,
      notes: (req.body || {}).notes ?? null,
    }, getDatabase());
    recordAuditEvent({
      type: 'sync.reconciliation_recorded', actor: { userId: user.userId, role: user.role },
      entity: { type: 'inventory_discrepancy', id: key },
      summary: `Acknowledged inventory discrepancy ${key}`, metadata: { key },
    });
    return { action };
  }, 201);
});

// ── Safe compensation execution (Part B) ─────────────────────────────────────
router.post('/conflicts/:uid/compensate', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => {
    const body = req.body || {};
    return executeCompensation({
      conflictUid: String(req.params.uid), action: body.action === 'void' ? 'void' : 'refund',
      paymentId: String(body.payment_id ?? ''), amountMinor: body.amount_minor != null ? Number(body.amount_minor) : undefined,
      reason: body.reason ?? null, user: userOf(req),
    });
  });
});
router.post('/conflicts/:uid/compensate-inventory', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => {
    const body = req.body || {};
    return executeInventoryCorrection({
      conflictUid: String(req.params.uid), productId: String(body.product_id ?? ''),
      variantId: body.variant_id ?? null, locationId: body.location_id ?? null,
      quantityDelta: Number(body.quantity_delta), reason: body.reason ?? 'conflict inventory correction', user: userOf(req),
    });
  });
});

// ── Controlled catalog promotion (Part C) ───────────────────────────────────
router.get('/catalog/promotable', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => ({ items: listPromotable(req.query.entity_type as string | undefined) }));
});
router.post('/catalog/promote', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => {
    const body = req.body || {};
    return promoteRemoteEntity({ entityType: String(body.entity_type ?? ''), uid: String(body.uid ?? ''), user: userOf(req) });
  });
});

// ── Licensing (Part I) ───────────────────────────────────────────────────────
router.get('/license', requirePermission('sales.reconcile'), (_req: Request, res: Response) => {
  handle(res, () => { const license = getLicense(); return { license, effectiveStatus: effectiveStatus(license) }; });
});
router.post('/license/activate', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => ({ license: activateLicense((req.body || {}) as License) }), 201);
});
router.get('/license/feature/:key', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => ({ feature: String(req.params.key), licensed: isFeatureLicensed(String(req.params.key), orgId() || undefined) }));
});

// ── Sync / device health ─────────────────────────────────────────────────────
router.get('/sync-health', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handleAsync(res, async () => operatorSyncHealth(await fetchCloudHealth()));
});
router.get('/device-health', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handleAsync(res, async () => deviceHealth(await fetchCloudHealth()));
});

export default router;
