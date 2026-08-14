/**
 * Feature entitlement HTTP surface (Milestone 7, Part K). Minimal —
 * enough for a development/preview settings screen, not the real Plemmo
 * Admin. Always operates on the current device's own organization,
 * resolved server-side — never accepts an organization_id from the client
 * (Part N).
 */

import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/security';
import {
  listOrganizationFeatures, listPresets, grantFeature, revokeFeature, applyPreset, setCustomFeatures,
} from '../core/features';
import { getCurrentOrganizationId } from '../core/location';

const router = Router();

function statusFor(error: any): number {
  return typeof error?.statusCode === 'number' ? error.statusCode : 500;
}

function requireOrganization(res: Response): string | null {
  const organizationId = getCurrentOrganizationId();
  if (!organizationId) {
    res.status(400).json({ error: 'No organization is configured on this install yet' });
    return null;
  }
  return organizationId;
}

router.get('/', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  const organizationId = requireOrganization(res);
  if (!organizationId) return;
  res.json({ features: listOrganizationFeatures(organizationId), presets: listPresets() });
});

router.post('/:key/grant', requireRole('owner'), (req: Request, res: Response) => {
  const organizationId = requireOrganization(res);
  if (!organizationId) return;
  try {
    grantFeature(organizationId, String(req.params.key));
    res.json({ features: listOrganizationFeatures(organizationId) });
  } catch (error: any) {
    res.status(statusFor(error)).json({ error: error?.message || 'Internal server error' });
  }
});

router.post('/:key/revoke', requireRole('owner'), (req: Request, res: Response) => {
  const organizationId = requireOrganization(res);
  if (!organizationId) return;
  try {
    revokeFeature(organizationId, String(req.params.key));
    res.json({ features: listOrganizationFeatures(organizationId) });
  } catch (error: any) {
    res.status(statusFor(error)).json({ error: error?.message || 'Internal server error' });
  }
});

router.post('/apply-preset', requireRole('owner'), (req: Request, res: Response) => {
  const organizationId = requireOrganization(res);
  if (!organizationId) return;
  try {
    applyPreset(organizationId, String((req.body || {}).preset_id));
    res.json({ features: listOrganizationFeatures(organizationId) });
  } catch (error: any) {
    res.status(statusFor(error)).json({ error: error?.message || 'Internal server error' });
  }
});

router.post('/custom', requireRole('owner'), (req: Request, res: Response) => {
  const organizationId = requireOrganization(res);
  if (!organizationId) return;
  try {
    setCustomFeatures(organizationId, (req.body || {}).feature_keys || []);
    res.json({ features: listOrganizationFeatures(organizationId) });
  } catch (error: any) {
    res.status(statusFor(error)).json({ error: error?.message || 'Internal server error' });
  }
});

export const featureRoutes = router;
