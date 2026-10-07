/**
 * GET /api/kitchen-queue — how many orders are waiting on the kitchen, for the till's sidebar badge and dashboard.
 * Tickets themselves live on the kitchen display; this is only the count and how long the oldest has waited, so
 * the till can tell the truth about the kitchen without reading the kitchen's data.
 */
import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { getDatabase } from '../db';
import { requireRole } from '../middleware/security';

const router = Router();
router.use(expressRateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down and try again shortly.' } }));

const LATE_MINUTES = 10;

router.get('/', requireRole('owner', 'manager', 'cashier', 'waiter', 'chef'), (_req: Request, res: Response) => {
  try {
    const rows = getDatabase().prepare("SELECT created_at FROM orders WHERE status IN ('pending', 'preparing') ORDER BY created_at ASC").all() as { created_at: string }[];
    const nowMs = Date.now();
    const ageMinutes = (s: string) => {
      const t = Date.parse(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z');
      return Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / 60000)) : 0;
    };
    const ages = rows.map((r) => ageMinutes(r.created_at));
    res.json({ open: rows.length, oldest_minutes: ages.length ? Math.max(...ages) : 0, late: ages.filter((a) => a >= LATE_MINUTES).length, late_after_minutes: LATE_MINUTES });
  } catch (error) {
    console.error('[KitchenQueue] failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export const kitchenQueueRoutes = router;
