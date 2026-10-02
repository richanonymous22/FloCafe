/**
 * Offers HTTP surface. Thin handlers over main/core/offers.ts.
 *   GET    /api/offers               all offers (the till uses this to list them)
 *   POST   /api/offers               create            (offers.manage)
 *   PUT    /api/offers/:id           change            (offers.manage)
 *   POST   /api/offers/:id/active    { active }        (offers.manage)
 *   DELETE /api/offers/:id           archive           (offers.manage)
 *   POST   /api/offers/preview       { items, customer_id } what offers would save on a basket
 *   GET    /api/offers/usage         savings per offer for a period (reports.view)
 */
import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { requireRole } from '../middleware/security';
import { requirePermission } from '../middleware/authorize';
import { archiveOffer, createOffer, getOffer, listOffers, OfferError, offerUsage, previewOffers, setOfferActive, updateOffer } from '../core/offers';
import { recordAuditEvent } from '../core/audit';

const router = Router();
router.use(expressRateLimit({ windowMs: 60 * 1000, limit: 1200, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down and try again shortly.' } }));

function fail(error: any, res: Response): void {
  const status = error instanceof OfferError ? error.statusCode : 500;
  if (status >= 500) console.error('[Offers] failed:', error);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : error.message });
}
const actor = (req: Request) => ((req as any).user?.userId as string | undefined) ?? null;
const manage = requirePermission('offers.manage');
const readers = requireRole('owner', 'manager', 'cashier', 'waiter');

// Declared before '/:id' so the words are not read as ids.
router.post('/preview', readers, (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (!Array.isArray(b.items)) throw new OfferError('items must be a list');
    res.json(previewOffers(b.items.map((i: any) => ({ product_id: String(i.product_id ?? ''), variant_id: i.variant_id ? String(i.variant_id) : null, quantity: Number(i.quantity) })), b.customer_id ? String(b.customer_id) : null));
  } catch (e) { fail(e, res); }
});

router.get('/usage', requirePermission('reports.view'), (req: Request, res: Response) => {
  try {
    const from = String(req.query.from || '1970-01-01 00:00:00'); const to = String(req.query.to || '9999-12-31 23:59:59');
    res.json({ usage: offerUsage(from, to) });
  } catch (e) { fail(e, res); }
});

router.get('/', readers, (req: Request, res: Response) => {
  try { res.json({ offers: listOffers({ includeArchived: req.query.archived === '1' }) }); } catch (e) { fail(e, res); }
});

router.post('/', manage, (req: Request, res: Response) => {
  try {
    const offer = createOffer(req.body || {}, actor(req));
    recordAuditEvent({ type: 'offer.changed', actor: { userId: actor(req) }, entity: { type: 'offer', id: offer.id }, summary: `Offer created: ${offer.name}`, metadata: { kind: offer.kind } });
    res.status(201).json({ offer });
  } catch (e) { fail(e, res); }
});

router.put('/:id', manage, (req: Request, res: Response) => {
  try {
    const offer = updateOffer(String(req.params.id), req.body || {});
    recordAuditEvent({ type: 'offer.changed', actor: { userId: actor(req) }, entity: { type: 'offer', id: offer.id }, summary: `Offer changed: ${offer.name}`, metadata: { kind: offer.kind } });
    res.json({ offer });
  } catch (e) { fail(e, res); }
});

router.post('/:id/active', manage, (req: Request, res: Response) => {
  try {
    const active = (req.body || {}).active;
    if (typeof active !== 'boolean') throw new OfferError('active must be true or false');
    const offer = setOfferActive(String(req.params.id), active);
    recordAuditEvent({ type: 'offer.changed', actor: { userId: actor(req) }, entity: { type: 'offer', id: offer.id }, summary: `Offer ${active ? 'switched on' : 'switched off'}: ${offer.name}`, metadata: { active } });
    res.json({ offer });
  } catch (e) { fail(e, res); }
});

router.delete('/:id', manage, (req: Request, res: Response) => {
  try {
    const offer = getOffer(String(req.params.id));
    archiveOffer(String(req.params.id));
    recordAuditEvent({ type: 'offer.changed', actor: { userId: actor(req) }, entity: { type: 'offer', id: String(req.params.id) }, summary: `Offer removed: ${offer?.name ?? ''}`, metadata: { archived: true } });
    res.status(204).send();
  } catch (e) { fail(e, res); }
});

export const offerRoutes = router;
