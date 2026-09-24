/**
 * Cash drawer API — sessions, movements and denomination counting.
 *
 * Plemmo is authoritative for the drawer (Meridian integration). All money is
 * in minor units. Authorization is server-enforced via requireRole; the
 * frontend's own role checks are UX only.
 */
import { createHash } from 'crypto';
import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/security';
import { getSettingValue } from '../db';
import { getCurrentLocationId } from '../core/location';
import {
  openCashSession, closeCashSession, recordCashMovement,
  getOpenCashSession, getCashSession, listCashMovements, listCashSessions,
  expectedCashMinor, CashError, CashMovementType,
} from '../core/cash';

const router = Router();

function currency(): string {
  return (getSettingValue('currency') || 'INR').toUpperCase();
}
function idem(req: Request, body: unknown): { key: string; requestHash: string; userId: string } | null {
  const key = req.header('Idempotency-Key');
  if (!key) return null;
  return {
    key,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    userId: String((req as any).user.userId),
  };
}
function fail(res: Response, error: any) {
  const status = error instanceof CashError ? error.statusCode : (error?.statusCode || 500);
  if (status >= 500) console.error('[Cash] Error:', error);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : error.message });
}

// Attach movements + live expected total to a session for the client.
function withDetail(session: any) {
  if (!session) return session;
  const movements = listCashMovements(session.id);
  const expected = session.status === 'open' ? expectedCashMinor(session.id) : (session.expected_minor ?? expectedCashMinor(session.id));
  return { ...session, movements, expected_minor: session.status === 'open' ? expected : session.expected_minor, live_expected_minor: expected };
}

// GET /api/cash/session — the current open session for this location (or null).
router.get('/session', requireRole('owner', 'manager', 'cashier'), (_req: Request, res: Response) => {
  try {
    const session = getOpenCashSession(getCurrentLocationId());
    res.json({ session: session ? withDetail(session) : null });
  } catch (error) { fail(res, error); }
});

// GET /api/cash/sessions — recent sessions (history).
router.get('/sessions', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    res.json({ sessions: listCashSessions({ limit }) });
  } catch (error) { fail(res, error); }
});

// GET /api/cash/session/:id — one session with its movements.
router.get('/session/:id', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const session = getCashSession(req.params.id as string);
    if (!session) return res.status(404).json({ error: 'Cash session not found' });
    res.json({ session: withDetail(session) });
  } catch (error) { fail(res, error); }
});

// POST /api/cash/session/open — open a drawer with a float / denomination count.
router.post('/session/open', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const { opening_float_minor, opening_counts, notes } = req.body || {};
    const session = openCashSession({
      locationId: getCurrentLocationId(),
      currency: currency(),
      userId: String((req as any).user.userId),
      openingFloatMinor: opening_float_minor,
      openingCounts: opening_counts ?? null,
      notes: notes ?? null,
      idempotency: idem(req, req.body || {}),
    });
    res.status(201).json({ session: withDetail(session) });
  } catch (error) { fail(res, error); }
});

// POST /api/cash/session/:id/movement — pay-in / pay-out / drop / no-sale / float adjust.
router.post('/session/:id/movement', requireRole('owner', 'manager', 'cashier'), (req: Request, res: Response) => {
  try {
    const { type, amount_minor, reason, reference } = req.body || {};
    const result = recordCashMovement({
      sessionId: req.params.id as string,
      type: type as CashMovementType,
      amountMinor: amount_minor,
      reason: reason ?? null,
      reference: reference ?? null,
      actorUserId: String((req as any).user.userId),
      idempotency: idem(req, { id: req.params.id, ...req.body }),
    });
    res.status(201).json(result);
  } catch (error) { fail(res, error); }
});

// POST /api/cash/session/:id/close — count down, reconcile, and close.
router.post('/session/:id/close', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { counted_minor, closing_counts, notes } = req.body || {};
    const result = closeCashSession({
      sessionId: req.params.id as string,
      countedMinor: counted_minor,
      closingCounts: closing_counts ?? null,
      closedBy: String((req as any).user.userId),
      notes: notes ?? null,
      idempotency: idem(req, { id: req.params.id, ...req.body }),
    });
    res.json(result);
  } catch (error) { fail(res, error); }
});

export { router as cashRoutes };
export default router;
