/**
 * Canonical Express gate for AuthorizationService (Milestone 8, Part B/C).
 *
 * `requirePermission()` is a single middleware call that performs the
 * "permission check → location access check" sequence the milestone's own
 * conceptual flow describes, by wrapping `requireCan()` directly rather
 * than duplicating its logic. Where a route also needs a location check,
 * pass `locationId` instead of chaining a separate `requireLocationAccess`
 * call — one canonical call site, not two independent ones that could
 * drift apart.
 *
 * This does not replace `requireRole()`. It is the gate for the specific
 * business-critical routes migrated in Milestone 8, Part C — see
 * docs/MILESTONE_8_AUTHORIZATION.md for which routes and why.
 */

import { Request, Response, NextFunction } from 'express';
import { requireCan, AuthorizationError, Permission, AuthUser } from '../core/authorization';

type LocationResolver = (req: Request) => string | null | undefined;

export interface RequirePermissionOptions {
  /**
   * Resolves the location id this specific request targets, or
   * null/undefined if the request has none — in which case the location
   * check passes trivially, exactly like `requireLocationAccess`. Pass an
   * array when a request touches more than one location (e.g. a transfer's
   * `from_location_id` and `to_location_id`) — every resolved location must
   * pass.
   */
  locationId?: LocationResolver | LocationResolver[];
}

export function requirePermission(permission: Permission, options: RequirePermissionOptions = {}) {
  const resolvers = options.locationId
    ? (Array.isArray(options.locationId) ? options.locationId : [options.locationId])
    : [];
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user as AuthUser | undefined;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    try {
      for (const resolve of resolvers) {
        requireCan(user, permission, { locationId: resolve(req) });
      }
      if (resolvers.length === 0) {
        requireCan(user, permission);
      }
      next();
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      throw error;
    }
  };
}
