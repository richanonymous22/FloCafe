/**
 * Card terminal HTTP surface. Thin handlers over main/core/card-terminal.
 *   GET    /api/card/config                 which provider this till uses, and which are available
 *   PUT    /api/card/config                 { provider }  (owner/manager)
 *   GET    /api/card/terminals              terminals the provider knows
 *   POST   /api/card/attempts               { bill_id?, amount, tip?, terminal_id? } send a sale to the terminal
 *   GET    /api/card/attempts/:id           ask the provider where it is (poll this)
 *   POST   /api/card/attempts/:id/cancel
 *   GET    /api/card/reconciliation         approved-but-unrecorded card money and mismatches (owner/manager)
 * The browser never marks anything approved; only the provider's answer does.
 */
import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { requireRole } from '../middleware/security';
import { getDatabase, now } from '../db';
import { recordAuditEvent } from '../core/audit';
import { activeProviderId, availableProviderIds, getCardProvider, resetCardProviders } from '../core/card-terminal/registry';
import { CardError, cancelAttempt, getAttempt, listCardMismatches, listOrphanAttempts, listTerminals, publicAttempt, refreshAttempt, startCardSale } from '../core/card-terminal/service';

const router = Router();
router.use(expressRateLimit({ windowMs: 60 * 1000, limit: 1200, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down and try again shortly.' } }));

function fail(error: any, res: Response): void {
  const status = error instanceof CardError ? error.statusCode : typeof error?.statusCode === 'number' ? error.statusCode : 500;
  if (status >= 500 && !(error instanceof CardError)) console.error('[Card] failed:', error);
  res.status(status).json({ error: status >= 500 && !(error instanceof CardError) ? 'Internal server error' : error.message, ...(error instanceof CardError && error.code ? { code: error.code } : {}) });
}
const actor = (req: Request) => ((req as any).user?.userId as string | undefined) ?? null;
const till = requireRole('owner', 'manager', 'cashier');
const admin = requireRole('owner', 'manager');

function minor(value: unknown, label: string, allowZero = false): number {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new CardError(`${label} must be a number with at most 2 decimal places`, 400);
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || (!allowZero && cents <= 0)) throw new CardError(`${label} must be greater than zero`, 400);
  return cents;
}

router.get('/config', till, (_req: Request, res: Response) => {
  const provider = getCardProvider();
  res.json({
    provider: activeProviderId(), label: provider?.label ?? null, simulated: provider?.simulated ?? false,
    available: availableProviderIds(), enabled: !!provider,
  });
});

router.put('/config', admin, (req: Request, res: Response) => {
  try {
    const chosen = String((req.body || {}).provider ?? '');
    if (chosen !== 'none' && !availableProviderIds().includes(chosen)) throw new CardError('That card provider is not available in this build.', 400);
    getDatabase().prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('card_provider', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(chosen, now());
    resetCardProviders();
    recordAuditEvent({ type: 'settings.changed', actor: { userId: actor(req) }, entity: { type: 'setting', id: 'card_provider' }, summary: `Card provider set to ${chosen}`, metadata: { provider: chosen } });
    res.json({ provider: activeProviderId() });
  } catch (e) { fail(e, res); }
});

router.get('/terminals', till, async (_req: Request, res: Response) => {
  try { res.json({ terminals: await listTerminals() }); } catch (e) { fail(e, res); }
});

router.post('/attempts', till, async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const attempt = await startCardSale({
      billId: b.bill_id === undefined || b.bill_id === null || b.bill_id === '' ? null : Number(b.bill_id),
      amountMinor: minor(b.amount, 'Amount'),
      tipMinor: b.tip === undefined || b.tip === null ? 0 : minor(b.tip, 'Tip', true),
      terminalId: typeof b.terminal_id === 'string' ? b.terminal_id.slice(0, 64) : null,
      userId: actor(req),
    });
    res.status(201).json(publicAttempt(attempt));
  } catch (e) { fail(e, res); }
});

router.get('/attempts/:id', till, async (req: Request, res: Response) => {
  try {
    if (!getAttempt(String(req.params.id))) throw new CardError('Card attempt not found', 404);
    res.json(publicAttempt(await refreshAttempt(String(req.params.id))));
  } catch (e) { fail(e, res); }
});

router.post('/attempts/:id/cancel', till, async (req: Request, res: Response) => {
  try { res.json(publicAttempt(await cancelAttempt(String(req.params.id), actor(req)))); } catch (e) { fail(e, res); }
});

router.get('/reconciliation', admin, (_req: Request, res: Response) => {
  try { res.json({ orphans: listOrphanAttempts(), mismatches: listCardMismatches() }); } catch (e) { fail(e, res); }
});

export const cardRoutes = router;
