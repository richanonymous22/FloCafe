/**
 * Plemmo API — sales conflict + reconciliation routes (SYNC-F, Part N).
 *
 * Backend/domain endpoints a future Plemmo Admin console will consume. There
 * is NO frontend screen yet — this is the API contract only.
 *
 * Every route is gated by `requirePermission('sales.reconcile')` — the
 * canonical Milestone 8 authorization path. `sales.reconcile` is an
 * owner/manager capability (main/core/authorization.ts); a cashier / waiter /
 * chef is refused. The resolution engine additionally enforces location
 * access against each conflict's own location, so authorization is checked
 * both at the route boundary and at the domain boundary.
 */

import { Router, Request, Response } from 'express';
import { requirePermission } from '../middleware/authorize';
import { AuthUser } from '../core/authorization';
import { listConflicts, getConflict, listActions } from '../core/sync/conflict-store';
import { ConflictStatus } from '../core/sync/conflict-model';
import {
  acknowledgeConflict, resolveConflict, availableStrategies,
  ConflictNotFoundError, ConflictStateError, IllegalResolutionError,
} from '../core/sync/conflict-resolution';
import { AuthorizationError } from '../core/authorization';
import {
  getOrderReconciliation, getBillReconciliation, getOrderHistory, getBillHistory,
} from '../core/sync/sales-reconciliation';
import { listPending } from '../core/sync/pending-relationships';
import { recordReconciliationAction } from '../core/sync/conflict-store';
import { getDatabase } from '../db';

const router = Router();

function userOf(req: Request): AuthUser {
  const u = (req as any).user;
  return { userId: String(u?.userId ?? u?.id ?? ''), role: String(u?.role ?? '') };
}

/** Maps a thrown domain error to its HTTP status, defaulting to 500. */
function handle(res: Response, fn: () => unknown, okStatus = 200): void {
  try {
    res.status(okStatus).json({ data: fn() });
  } catch (error) {
    const e = error as Error & { statusCode?: number };
    if (e instanceof AuthorizationError || e instanceof ConflictNotFoundError || e instanceof ConflictStateError || e instanceof IllegalResolutionError) {
      res.status(e.statusCode ?? 400).json({ error: e.message, code: e.name });
      return;
    }
    res.status(500).json({ error: e.message });
  }
}

// ── Conflicts ───────────────────────────────────────────────────────────────
router.get('/conflicts', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => {
    const status = req.query.status as ConflictStatus | undefined;
    return {
      conflicts: listConflicts({
        status,
        entityType: req.query.entity_type as string | undefined,
        entityUid: req.query.entity_uid as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    };
  });
});

router.get('/conflicts/:uid', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => {
    const conflict = getConflict(String(req.params.uid));
    if (!conflict) throw new ConflictNotFoundError(String(req.params.uid));
    return {
      conflict,
      actions: listActions(conflict.conflict_uid),
      availableStrategies: availableStrategies(conflict),
    };
  });
});

router.post('/conflicts/:uid/acknowledge', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => ({
    conflict: acknowledgeConflict({ conflictUid: String(req.params.uid), user: userOf(req), notes: (req.body || {}).notes ?? null }),
  }));
});

router.post('/conflicts/:uid/resolve', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => {
    const body = req.body || {};
    return {
      conflict: resolveConflict({
        conflictUid: String(req.params.uid),
        strategy: String(body.strategy ?? ''),
        user: userOf(req),
        notes: body.notes ?? null,
        compensationReference: body.compensation_reference ?? null,
      }),
    };
  });
});

// ── Reconciliation ───────────────────────────────────────────────────────────
router.get('/reconciliation/order/:orderUid', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => getOrderReconciliation(String(req.params.orderUid)));
});

router.get('/reconciliation/order/:orderUid/history', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => getOrderHistory(String(req.params.orderUid)));
});

router.get('/reconciliation/bill/:billUid', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => getBillReconciliation(String(req.params.billUid)));
});

router.get('/reconciliation/bill/:billUid/history', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => getBillHistory(String(req.params.billUid)));
});

router.get('/pending-relationships', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => ({ pending: listPending((req.query.status as any) ?? 'pending') }));
});

/** Records a free-form reconciliation action (a note / manual reconciliation entry). */
router.post('/reconciliation/action', requirePermission('sales.reconcile'), (req: Request, res: Response) => {
  handle(res, () => {
    const body = req.body || {};
    const user = userOf(req);
    const action = recordReconciliationAction({
      conflictUid: body.conflict_uid ?? null,
      entityType: body.entity_type ?? null,
      entityUid: body.entity_uid ?? null,
      actionType: body.action_type === 'note' ? 'note' : 'reconciliation',
      actorUserId: user.userId,
      actorRole: user.role,
      notes: body.notes ?? null,
      reference: body.reference ?? null,
    }, getDatabase());
    return { action };
  }, 201);
});

export default router;
