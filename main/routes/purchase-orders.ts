/**
 * Purchase order + receiving HTTP surface (Milestone 5). Thin handlers
 * only — logic lives in main/modules/purchasing/*.
 */

import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/security';
import { requireLocationAccess } from '../middleware/location-access';
import { requireFeature } from '../middleware/feature-access';
import {
  createPurchaseOrder, addItem, updateItem, removeItem, markOrdered, cancelPurchaseOrder,
  getPurchaseOrder, listPurchaseOrders,
} from '../modules/purchasing/purchase-orders';
import { receiveGoods } from '../modules/purchasing/receiving';
import { purchasesBySupplier, outstandingPurchaseOrders, recentGoodsReceived, stockReceivedByDate } from '../modules/purchasing/reports';
import { getCurrentLocationId } from '../core/location';
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
    if (status >= 500) console.error('[PurchaseOrders] request failed:', error);
    res.status(status).json({ error: error?.message || 'Internal server error' });
  }
}

router.get('/', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const status = req.query.status ? String(req.query.status) as any : undefined;
  const supplierId = req.query.supplier_id ? String(req.query.supplier_id) : undefined;
  res.json({ purchaseOrders: listPurchaseOrders({ status, supplierId }) });
});

// Registered before '/:id' — otherwise Express would match "reports" as an :id.
router.get('/reports/by-supplier', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  res.json({ suppliers: purchasesBySupplier() });
});

router.get('/reports/outstanding', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  res.json({ purchaseOrders: outstandingPurchaseOrders() });
});

router.get('/reports/recent-receipts', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const limit = req.query.limit ? Math.min(200, Math.max(1, Number(req.query.limit))) : 50;
  res.json({ receipts: recentGoodsReceived(limit) });
});

router.get('/reports/received-by-date', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const to = req.query.to ? String(req.query.to) : new Date().toISOString().slice(0, 10);
  const from = req.query.from ? String(req.query.from) : to;
  res.json({ days: stockReceivedByDate(from, to) });
});

router.get('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const po = getPurchaseOrder(String(req.params.id));
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  res.json({ purchaseOrder: po });
});

router.post('/', requireRole('owner', 'manager'), requireFeature('retail.purchasing'),
  requireLocationAccess((req) => (req.body || {}).location_id || getCurrentLocationId()),
  (req: Request, res: Response) => {
  handle(res, () => {
    const body = req.body || {};
    const user = (req as any).user;
    return { purchaseOrder: createPurchaseOrder({
      supplierId: body.supplier_id,
      referenceNumber: body.reference_number,
      orderDate: body.order_date,
      expectedDate: body.expected_date,
      notes: body.notes,
      locationId: body.location_id,
      createdBy: user?.userId,
    }) };
  }, 201);
});

router.post('/:id/items', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  handle(res, () => {
    const body = req.body || {};
    return { item: addItem(String(req.params.id), {
      productId: body.product_id, variantId: body.variant_id, quantityOrdered: body.quantity_ordered,
      unitCost: body.unit_cost, tax: body.tax,
    }) };
  }, 201);
});

router.put('/:id/items/:itemId', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  handle(res, () => {
    const body = req.body || {};
    return { item: updateItem(String(req.params.id), String(req.params.itemId), {
      quantityOrdered: body.quantity_ordered, unitCost: body.unit_cost, tax: body.tax,
    }) };
  });
});

router.delete('/:id/items/:itemId', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    removeItem(String(req.params.id), String(req.params.itemId));
    res.status(204).send();
  } catch (error: any) {
    const status = statusFor(error);
    if (status >= 500) console.error('[PurchaseOrders] remove item failed:', error);
    res.status(status).json({ error: error?.message || 'Internal server error' });
  }
});

router.post('/:id/mark-ordered', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  handle(res, () => ({ purchaseOrder: markOrdered(String(req.params.id)) }));
});

router.post('/:id/cancel', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  handle(res, () => ({ purchaseOrder: cancelPurchaseOrder(String(req.params.id)) }));
});

router.post('/:id/receive', requireRole('owner', 'manager'),
  requireLocationAccess((req) => {
    const po = getDatabase().prepare('SELECT location_id FROM purchase_orders WHERE id = ?').get(req.params.id) as { location_id: string | null } | undefined;
    return po?.location_id;
  }),
  (req: Request, res: Response) => {
  handle(res, () => {
    const body = req.body || {};
    const user = (req as any).user;
    return receiveGoods({
      purchaseOrderId: String(req.params.id),
      items: body.items,
      actorUserId: user?.userId,
      idempotency: body.idempotency_key
        ? { key: body.idempotency_key, requestHash: body.request_hash || '', userId: String(user?.userId) }
        : null,
    });
  }, 201);
});

export const purchaseOrderRoutes = router;
