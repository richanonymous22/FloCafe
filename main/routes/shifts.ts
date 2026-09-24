/**
 * Staff shifts / timeclock API (Meridian integration).
 *
 * A staff member clocks themselves in/out; managers/owners can view all shifts
 * and worked-hours. Authorization is server-enforced.
 */
import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/security';
import { getCurrentLocationId } from '../core/location';
import { clockIn, clockOut, getOpenShift, listShifts, hoursWorked, ShiftError } from '../core/shifts';

const router = Router();

function fail(res: Response, error: any) {
  const status = error instanceof ShiftError ? error.statusCode : (error?.statusCode || 500);
  if (status >= 500) console.error('[Shifts] Error:', error);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : error.message });
}

// GET /api/shifts/me — the caller's current open shift (or null).
router.get('/me', requireRole('owner', 'manager', 'cashier', 'chef', 'waiter'), (req: Request, res: Response) => {
  try {
    res.json({ shift: getOpenShift(String((req as any).user.userId)) });
  } catch (error) { fail(res, error); }
});

// POST /api/shifts/clock-in — clock the caller in.
router.post('/clock-in', requireRole('owner', 'manager', 'cashier', 'chef', 'waiter'), (req: Request, res: Response) => {
  try {
    const shift = clockIn({ userId: String((req as any).user.userId), locationId: getCurrentLocationId(), note: (req.body || {}).note ?? null });
    res.status(201).json({ shift });
  } catch (error) { fail(res, error); }
});

// POST /api/shifts/clock-out — clock the caller out.
router.post('/clock-out', requireRole('owner', 'manager', 'cashier', 'chef', 'waiter'), (req: Request, res: Response) => {
  try {
    const shift = clockOut({ userId: String((req as any).user.userId), note: (req.body || {}).note ?? null });
    res.json({ shift });
  } catch (error) { fail(res, error); }
});

// GET /api/shifts — timesheet history (manager+). Optional user_id/from/to.
router.get('/', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const userId = req.query.user_id ? String(req.query.user_id) : undefined;
    const from = req.query.from ? String(req.query.from) : undefined;
    const to = req.query.to ? String(req.query.to) : undefined;
    const shifts = listShifts({ userId, from, to });
    const body: any = { shifts };
    if (userId && from && to) body.hours = hoursWorked(userId, from, to);
    res.json(body);
  } catch (error) { fail(res, error); }
});

export { router as shiftRoutes };
export default router;
