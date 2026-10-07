/**
 * Application updates.
 *   GET  /api/updates/status      anyone signed in: version, what is ready, whether it is safe to install, history
 *   PUT  /api/updates/settings    owner: { mode, window_start_hour, window_end_hour }
 *   POST /api/updates/defer       owner or manager: { minutes } — "remind me later"
 *   POST /api/updates/check       owner or manager
 *   POST /api/updates/install     owner or manager: backs up, verifies, then restarts into the new version
 */
import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { requireRole } from '../middleware/security';
import { UpdateError, checkNow, deferUpdate, installNow, setUpdateSettings, updateStatusBody } from '../services/update-manager';

const router = Router();
router.use(expressRateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Wait a minute and try again.' } }));

function fail(e: any, res: Response): void {
  if (e instanceof UpdateError) { res.status(e.statusCode).json({ error: e.message, code: e.code, reasons: e.reasons }); return; }
  console.error('[Updates] failed:', e);
  res.status(500).json({ error: 'Internal server error' });
}

router.get('/status', requireRole('owner', 'manager', 'cashier', 'chef', 'waiter'), (_req: Request, res: Response) => { try { res.json(updateStatusBody()); } catch (e) { fail(e, res); } });
router.put('/settings', requireRole('owner'), (req: Request, res: Response) => {
  try { const b = req.body || {}; setUpdateSettings({ mode: b.mode, window_start_hour: b.window_start_hour, window_end_hour: b.window_end_hour }); res.json(updateStatusBody()); } catch (e) { fail(e, res); }
});
router.post('/defer', requireRole('owner', 'manager'), (req: Request, res: Response) => { try { deferUpdate(Number((req.body || {}).minutes)); res.json(updateStatusBody()); } catch (e) { fail(e, res); } });
router.post('/check', requireRole('owner', 'manager'), async (_req: Request, res: Response) => { try { await checkNow(); res.json(updateStatusBody()); } catch (e) { fail(e, res); } });
router.post('/install', requireRole('owner', 'manager'), async (req: Request, res: Response) => {
  try { const r = await installNow({ actorUserId: (req as any).user?.userId ?? null }); res.status(202).json({ installing: true, ...r }); } catch (e) { fail(e, res); }
});

export const updateRoutes = router;
