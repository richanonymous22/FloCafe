/**
 * Stocktake HTTP surface. Thin handlers over main/core/stocktake.ts.
 *   POST   /api/stocktakes                 start (optionally limited to categories)
 *   GET    /api/stocktakes                 history
 *   GET    /api/stocktakes/:id             lines + variance summary
 *   PUT    /api/stocktakes/:id/lines       { product_id, variant_id?, quantity, mode: set|add }
 *   POST   /api/stocktakes/:id/scan        { code, quantity? }  adds to the matching line (default +1)
 *   POST   /api/stocktakes/:id/approve     post the adjustments (uncounted: ignore|zero)
 *   POST   /api/stocktakes/:id/cancel
 */
import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { requirePermission } from '../middleware/authorize';
import { approveStocktake, cancelStocktake, findLine, getStocktake, listStocktakes, recordCount, startStocktake } from '../core/stocktake';
import { getCurrentLocationId } from '../core/location';

const router = Router();
router.use(expressRateLimit({ windowMs: 60 * 1000, limit: 1200, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down and try again shortly.' } }));

function fail(error: any, res: Response): void {
  const status = typeof error?.statusCode === 'number' ? error.statusCode : 500;
  if (status >= 500) console.error('[Stocktake] failed:', error);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : error.message });
}
const actor = (req: Request) => ((req as any).user?.userId as string | undefined) ?? null;
const perm = requirePermission('inventory.stocktake', { locationId: () => getCurrentLocationId() });

router.post('/', perm, (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const s = startStocktake({ name: typeof b.name === 'string' ? b.name.slice(0, 80) : undefined, categoryIds: Array.isArray(b.category_ids) ? b.category_ids.map(String) : null, actorUserId: actor(req) });
    res.status(201).json(getStocktake(s.id));
  } catch (e) { fail(e, res); }
});
router.get('/', perm, (req: Request, res: Response) => { try { res.json({ stocktakes: listStocktakes(Number(req.query.limit) || 50) }); } catch (e) { fail(e, res); } });
router.get('/:id', perm, (req: Request, res: Response) => { try { res.json(getStocktake(String(req.params.id))); } catch (e) { fail(e, res); } });

router.put('/:id/lines', perm, (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const line = recordCount(String(req.params.id), { productId: String(b.product_id || ''), variantId: b.variant_id ? String(b.variant_id) : null, quantity: Number(b.quantity), mode: b.mode === 'add' ? 'add' : 'set', actorUserId: actor(req) });
    res.json({ line, summary: getStocktake(String(req.params.id)).summary });
  } catch (e) { fail(e, res); }
});

router.post('/:id/scan', perm, (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const code = String((req.body || {}).code || '');
    const hit = findLine(id, code);
    if (!hit) { res.status(404).json({ error: `Nothing in this stocktake has the code "${code.slice(0, 40)}".`, code: 'unknown_code' }); return; }
    const qty = (req.body || {}).quantity === undefined ? 1 : Number(req.body.quantity);
    const line = recordCount(id, { productId: hit.productId, variantId: hit.variantId, quantity: qty, mode: 'add', actorUserId: actor(req) });
    res.json({ line, summary: getStocktake(id).summary });
  } catch (e) { fail(e, res); }
});

router.post('/:id/approve', perm, (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    res.json(approveStocktake(String(req.params.id), { actorUserId: actor(req), uncounted: b.uncounted === 'zero' ? 'zero' : 'ignore', note: typeof b.note === 'string' ? b.note.slice(0, 200) : undefined }));
  } catch (e) { fail(e, res); }
});
router.post('/:id/cancel', perm, (req: Request, res: Response) => { try { res.json({ stocktake: cancelStocktake(String(req.params.id), actor(req)) }); } catch (e) { fail(e, res); } });

export const stocktakeRoutes = router;
