/**
 * AI assistant API (Meridian integration). Advisory only — answers over an
 * authoritative snapshot, permission-gated, audited, and incapable of mutation.
 */
import { Router, Request, Response } from 'express';
import { requirePermission } from '../middleware/authorize';
import { ask, buildSnapshot } from '../core/ai';

const router = Router();

// POST /api/ai/ask { question } → { answer, source, snapshot }
router.post('/ask', requirePermission('reports.view'), async (req: Request, res: Response) => {
  try {
    const question = String((req.body || {}).question || '').slice(0, 2000);
    if (!question.trim()) return res.status(400).json({ error: 'A question is required' });
    const result = await ask(question, { userId: String((req as any).user.userId) });
    res.json(result);
  } catch (error: any) {
    console.error('[AI] ask failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/ai/snapshot → the authoritative business snapshot the assistant uses.
router.get('/snapshot', requirePermission('reports.view'), (_req: Request, res: Response) => {
  try {
    res.json({ snapshot: buildSnapshot() });
  } catch (error: any) {
    console.error('[AI] snapshot failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as aiRoutes };
export default router;
