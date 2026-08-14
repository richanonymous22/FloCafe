/**
 * Stock transfer HTTP surface (Milestone 6). Thin handlers only — logic
 * lives in main/core/transfers.ts.
 */

import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/security';
import { requireLocationAccess } from '../middleware/location-access';
import { requireFeature } from '../middleware/feature-access';
import {
  createTransfer, addTransferItem, removeTransferItem, completeTransfer, cancelTransfer,
  getTransfer, listTransfers,
} from '../core/transfers';
import { getDatabase } from '../db';

const router = Router();

function statusFor(error: any): number {
  return typeof error?.statusCode === 'number' ? error.statusCode : 500;
}

function handle(res: Response, fn: () => any, successStatus = 200): void {
  try {
    const result = fn();
    res.status(successStatus).json(result);
  } catch (error: any) {
    const status = statusFor(error);
    if (status >= 500) console.error('[Transfers] request failed:', error);
    res.status(status).json({ error: error?.message || 'Internal server error' });
  }
}

router.get('/', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const status = req.query.status ? String(req.query.status) : undefined;
  const locationId = req.query.location_id ? String(req.query.location_id) : undefined;
  res.json({ transfers: listTransfers({ status, locationId }) });
});

router.get('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const transfer = getTransfer(String(req.params.id));
  if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
  res.json({ transfer });
});

router.post('/', requireRole('owner', 'manager'), requireFeature('retail.transfers'),
  requireLocationAccess((req) => (req.body || {}).from_location_id),
  requireLocationAccess((req) => (req.body || {}).to_location_id),
  (req: Request, res: Response) => {
  handle(res, () => {
    const body = req.body || {};
    const user = (req as any).user;
    return { transfer: createTransfer({
      fromLocationId: body.from_location_id, toLocationId: body.to_location_id,
      referenceNumber: body.reference_number, notes: body.notes, createdBy: user?.userId,
    }) };
  }, 201);
});

router.post('/:id/items', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  handle(res, () => {
    const body = req.body || {};
    return { item: addTransferItem(String(req.params.id), {
      productId: body.product_id, variantId: body.variant_id, quantity: body.quantity,
    }) };
  }, 201);
});

router.delete('/:id/items/:itemId', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    removeTransferItem(String(req.params.id), String(req.params.itemId));
    res.status(204).send();
  } catch (error: any) {
    const status = statusFor(error);
    if (status >= 500) console.error('[Transfers] remove item failed:', error);
    res.status(status).json({ error: error?.message || 'Internal server error' });
  }
});

function loadTransferLocation(field: 'from_location_id' | 'to_location_id') {
  return (req: Request) => {
    const transfer = getDatabase().prepare(`SELECT ${field} as location_id FROM stock_transfers WHERE id = ?`).get(req.params.id) as { location_id: string | null } | undefined;
    return transfer?.location_id;
  };
}

router.post('/:id/complete', requireRole('owner', 'manager'),
  requireLocationAccess(loadTransferLocation('from_location_id')),
  requireLocationAccess(loadTransferLocation('to_location_id')),
  (req: Request, res: Response) => {
  handle(res, () => {
    const user = (req as any).user;
    return { transfer: completeTransfer(String(req.params.id), user?.userId) };
  });
});

router.post('/:id/cancel', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  handle(res, () => ({ transfer: cancelTransfer(String(req.params.id)) }));
});

export const transferRoutes = router;
