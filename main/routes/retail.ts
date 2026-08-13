/**
 * Retail HTTP surface (Milestone 3). Thin route handlers only — all business
 * logic lives in main/modules/retail/* and main/core/*. No route here ever
 * touches `tables`, `kitchen_stations`, or KDS: that is what "the retail
 * checkout does not require hospitality concepts" (success criterion 9)
 * means at the routing layer.
 */

import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/security';
import {
  createVariant, listVariantsForProduct, updateVariant, deactivateVariant, lookupByCode,
} from '../modules/retail/variants';
import { checkout } from '../modules/retail/checkout';
import { getRetailDailySummary } from '../modules/retail/reports';
import { openCashDrawer } from '../printers/thermal';

const router = Router();

function statusFor(error: any): number {
  return typeof error?.statusCode === 'number' ? error.statusCode : 500;
}

router.get('/variants', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  const productId = String(req.query.product_id || '');
  if (!productId) {
    return res.status(400).json({ error: 'product_id is required' });
  }
  res.json({ variants: listVariantsForProduct(productId) });
});

router.post('/variants', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const variant = createVariant({
      productId: body.product_id,
      name: body.name,
      sku: body.sku,
      barcode: body.barcode,
      price: body.price,
      cost: body.cost,
      taxCategoryId: body.tax_category_id,
      isDefault: body.is_default,
      isActive: body.is_active,
      sortOrder: body.sort_order,
    });
    res.status(201).json({ variant });
  } catch (error: any) {
    const status = statusFor(error);
    if (status >= 500) console.error('[Retail] create variant failed:', error);
    res.status(status).json({ error: error?.message || 'Internal server error' });
  }
});

router.put('/variants/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const variant = updateVariant(String(req.params.id), {
      name: body.name,
      sku: body.sku,
      barcode: body.barcode,
      price: body.price,
      cost: body.cost,
      taxCategoryId: body.tax_category_id,
      isDefault: body.is_default,
      isActive: body.is_active,
      sortOrder: body.sort_order,
    });
    res.json({ variant });
  } catch (error: any) {
    const status = statusFor(error);
    if (status >= 500) console.error('[Retail] update variant failed:', error);
    res.status(status).json({ error: error?.message || 'Internal server error' });
  }
});

router.delete('/variants/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    deactivateVariant(String(req.params.id));
    res.status(204).send();
  } catch (error: any) {
    const status = statusFor(error);
    if (status >= 500) console.error('[Retail] deactivate variant failed:', error);
    res.status(status).json({ error: error?.message || 'Internal server error' });
  }
});

router.get('/lookup', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  const code = String(req.query.code || '');
  if (!code) {
    return res.status(400).json({ error: 'code is required' });
  }
  const result = lookupByCode(code);
  if (!result) {
    return res.status(404).json({ error: 'No product or variant matches that code' });
  }
  res.json(result);
});

router.post('/checkout', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const user = (req as any).user;
    const result = checkout({
      lines: body.lines,
      customerId: body.customer_id ?? null,
      cashierUserId: user?.userId,
      tender: body.tender,
      idempotency: body.idempotency_key
        ? { key: body.idempotency_key, requestHash: body.request_hash || '' }
        : null,
    });
    res.status(201).json(result);
  } catch (error: any) {
    const status = statusFor(error);
    if (status >= 500) console.error('[Retail] checkout failed:', error);
    res.status(status).json({ error: error?.message || 'Internal server error' });
  }
});

router.post('/cash-drawer/open', requireRole('owner', 'manager', 'cashier'), async (_req: Request, res: Response) => {
  const result = await openCashDrawer();
  if (!result.ok) {
    return res.status(502).json({ error: result.detail || 'Could not open the cash drawer' });
  }
  res.json({ ok: true });
});

router.get('/reports/daily', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const date = String(req.query.date || new Date().toISOString().slice(0, 10));
  res.json(getRetailDailySummary(date));
});

export const retailRoutes = router;
