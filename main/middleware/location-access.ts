/**
 * Express middleware wrapper around AuthorizationService's location check
 * (Milestone 7, Part A). Deliberately not one giant global middleware —
 * each call site says exactly how to resolve the location a specific
 * request targets, since that differs by route (a request body field, or
 * a lookup against an existing row like a purchase order).
 *
 * Never trusts a client-supplied location_id at face value beyond using it
 * as the value to check permission for — the actual authorization decision
 * is made server-side against `user_locations` (or bypassed for
 * owner/manager), never by trusting anything the client claims about its
 * own authorization.
 */

import { Request, Response, NextFunction } from 'express';
import { hasLocationAccess } from '../core/authorization';

/**
 * `resolveLocationId` returns the location id a request targets (or null
 * if the request is location-agnostic, e.g. no location_id given and no
 * default applies — in which case the check passes trivially, since a
 * request naming no location has nothing to authorize against).
 */
export function requireLocationAccess(resolveLocationId: (req: Request) => string | null | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const locationId = resolveLocationId(req);
    if (!locationId) return next();
    if (!hasLocationAccess({ userId: user.userId, role: user.role }, locationId)) {
      return res.status(403).json({ error: 'Not authorized to operate at this location' });
    }
    next();
  };
}
