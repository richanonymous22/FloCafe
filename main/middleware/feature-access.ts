/**
 * Express middleware wrapper around FeatureService.isEnabled() (Milestone
 * 7, Part G). The organization is always resolved server-side from device
 * context — never taken from the client — so a disabled feature cannot be
 * invoked through the API just because a request claims a different
 * organization (Part N).
 */

import { Request, Response, NextFunction } from 'express';
import { isEnabled } from '../core/features';
import { getCurrentOrganizationId } from '../core/location';

export function requireFeature(featureKey: string) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const organizationId = getCurrentOrganizationId();
    if (!organizationId || !isEnabled(organizationId, featureKey)) {
      return res.status(403).json({ error: `Feature '${featureKey}' is not enabled for this organization` });
    }
    next();
  };
}
