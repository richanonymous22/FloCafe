/**
 * Plemmo Core — AuthorizationService (Milestone 7, Part B/C).
 *
 * A small, reusable authorization layer, deliberately independent of
 * Express: `can()` takes a plain `{ userId, role }` and an optional
 * `{ locationId }` context, so it is usable from routes, Core services, and
 * a future Admin API alike — not just as request middleware.
 *
 * ## Two questions, kept separate
 *
 *   1. "Does this role have this permission at all?" — `hasPermission()`,
 *      a static role → permission-set table. Additive to the existing
 *      `users.role` + `requireRole()` system, not a replacement: every
 *      existing route keeps using `requireRole()` exactly as before. This
 *      is new infrastructure for callers that need a finer-grained answer
 *      than "is this role in this list" — most don't yet, and this
 *      milestone does not force it onto them (Part B: "do not add feature
 *      checks to every route just for the sake of coverage").
 *   2. "Is this user allowed at this specific location?" — `hasLocationAccess()`,
 *      backed by Milestone 6's `user_locations` table
 *      (main/core/employee-access.ts). Owners and managers bypass this —
 *      they operate across every location in their organization by design;
 *      cashiers/waiters/chefs need an explicit grant.
 *
 * `can()` combines both. Callers that only care about one question call
 * `hasPermission()`/`hasLocationAccess()` directly.
 */

import { userHasLocationAccess } from './employee-access';

export type Permission =
  | 'sales.create' | 'sales.refund'
  | 'inventory.view' | 'inventory.adjust' | 'inventory.receive' | 'inventory.transfer'
  | 'purchasing.manage'
  | 'reports.view'
  | 'employees.manage'
  | 'locations.manage';

export type Role = 'owner' | 'manager' | 'cashier' | 'waiter' | 'chef';

/**
 * Roles that operate across every location in their organization without
 * an explicit `user_locations` grant — the same trust level `requireRole`
 * already gives them for everything else in the app.
 */
const LOCATION_UNRESTRICTED_ROLES: readonly Role[] = ['owner', 'manager'];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [
    'sales.create', 'sales.refund', 'inventory.view', 'inventory.adjust', 'inventory.receive',
    'inventory.transfer', 'purchasing.manage', 'reports.view', 'employees.manage', 'locations.manage',
  ],
  manager: [
    'sales.create', 'sales.refund', 'inventory.view', 'inventory.adjust', 'inventory.receive',
    'inventory.transfer', 'purchasing.manage', 'reports.view', 'employees.manage',
  ],
  cashier: ['sales.create', 'inventory.view'],
  waiter: ['sales.create'],
  chef: ['inventory.view'],
};

export interface AuthUser {
  userId: string;
  role: string;
}

export function hasPermission(role: string, permission: Permission): boolean {
  const permissions = ROLE_PERMISSIONS[role as Role];
  return permissions ? permissions.includes(permission) : false;
}

export function hasLocationAccess(user: AuthUser, locationId: string): boolean {
  if (LOCATION_UNRESTRICTED_ROLES.includes(user.role as Role)) return true;
  return userHasLocationAccess(user.userId, locationId);
}

export interface AuthorizationContext {
  locationId?: string | null;
}

export function can(user: AuthUser, permission: Permission, context: AuthorizationContext = {}): boolean {
  if (!hasPermission(user.role, permission)) return false;
  if (context.locationId && !hasLocationAccess(user, context.locationId)) return false;
  return true;
}

export class AuthorizationError extends Error {
  statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

/** Throws rather than returning false — for Core-service call sites that need to fail the operation, not just branch on it. */
export function requireCan(user: AuthUser, permission: Permission, context: AuthorizationContext = {}): void {
  if (!hasPermission(user.role, permission)) {
    throw new AuthorizationError(`Role '${user.role}' does not have permission '${permission}'`);
  }
  if (context.locationId && !hasLocationAccess(user, context.locationId)) {
    throw new AuthorizationError(`User is not authorized to operate at location ${context.locationId}`);
  }
}
