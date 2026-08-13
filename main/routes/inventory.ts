/**
 * Inventory HTTP surface (Milestone 4). Thin route handlers only — all
 * business logic lives in main/core/inventory.ts. Vertical-neutral: nothing
 * here is retail- or hospitality-specific, since inventory is a Core
 * capability either vertical can use (Part C).
 */

import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/security';
import { getBalance, getMovementHistory, adjustStock, listLowStock } from '../core/inventory';

const router = Router();

function statusFor(error: any): number {
  return typeof error?.statusCode === 'number' ? error.statusCode : 500;
}

router.get('/balance', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  const productId = String(req.query.product_id || '');
  if (!productId) {
    return res.status(400).json({ error: 'product_id is required' });
  }
  const variantId = req.query.variant_id ? String(req.query.variant_id) : null;
  res.json({ balance: getBalance(productId, variantId) });
});

router.get('/history', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  const productId = String(req.query.product_id || '');
  if (!productId) {
    return res.status(400).json({ error: 'product_id is required' });
  }
  const variantId = req.query.variant_id ? String(req.query.variant_id) : null;
  const limit = req.query.limit ? Math.min(500, Math.max(1, Number(req.query.limit))) : 100;
  res.json({ movements: getMovementHistory(productId, variantId, limit) });
});

router.get('/low-stock', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  res.json({ items: listLowStock() });
});

router.post('/adjust', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const user = (req as any).user;
    const movement = adjustStock({
      productId: body.product_id,
      variantId: body.variant_id ?? null,
      quantityDelta: body.quantity_delta,
      reason: body.reason,
      movementType: body.movement_type,
      actorUserId: user?.userId,
    });
    res.status(201).json({ movement });
  } catch (error: any) {
    const status = statusFor(error);
    if (status >= 500) console.error('[Inventory] adjust failed:', error);
    res.status(status).json({ error: error?.message || 'Internal server error' });
  }
});

export const inventoryRoutes = router;
