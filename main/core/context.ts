/**
 * Plemmo Core — the active device/register/location/organization context.
 *
 * A local install's identity was seeded once, by migration v68, into
 * `organizations`/`locations`/`registers`/`devices`, with pointers written
 * to `settings` (`plemmo_organization_id` etc.) so resolving "who am I"
 * doesn't require a query that assumes there's exactly one row of each.
 * `main/core/location.ts` (Milestone 5) already reads two of those
 * pointers for `InventoryService`; `main/core/audit.ts` independently
 * caches all four for audit-event attribution. This module is the one,
 * typed, full-object version of that same resolution — Part R's
 * `getDeviceContext()`/`getRegisterContext()`/`getLocationContext()`/
 * `getOrganizationContext()` — so no future caller (sync, licensing,
 * admin, reports) has to know settings keys or hand-roll a join.
 *
 * See docs/MILESTONE_6_MULTI_LOCATION.md § Active device context.
 */

import { getDatabase } from '../db';

export interface OrganizationContext {
  id: string;
  name: string;
  country: string | null;
}

export interface LocationContext {
  id: string;
  organizationId: string;
  name: string;
  code: string | null;
  isActive: boolean;
}

export interface RegisterContext {
  id: string;
  locationId: string;
  name: string;
  code: string | null;
  isActive: boolean;
}

export interface DeviceContext {
  id: string;
  registerId: string | null;
  name: string | null;
  status: string;
}

interface ContextCache {
  organization: OrganizationContext | null;
  location: LocationContext | null;
  register: RegisterContext | null;
  device: DeviceContext | null;
}

let cache: ContextCache | null = null;

function readPointer(db: ReturnType<typeof getDatabase>, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value || null;
}

function resolve(): ContextCache {
  if (cache) return cache;
  const db = getDatabase();

  const organizationId = readPointer(db, 'plemmo_organization_id');
  const locationId = readPointer(db, 'plemmo_location_id');
  const registerId = readPointer(db, 'plemmo_register_id');
  const deviceId = readPointer(db, 'plemmo_device_id');

  const organizationRow = organizationId
    ? db.prepare('SELECT id, name, country FROM organizations WHERE id = ?').get(organizationId) as { id: string; name: string; country: string | null } | undefined
    : undefined;
  const locationRow = locationId
    ? db.prepare('SELECT id, organization_id, name, code, is_active FROM locations WHERE id = ?').get(locationId) as { id: string; organization_id: string; name: string; code: string | null; is_active: number } | undefined
    : undefined;
  const registerRow = registerId
    ? db.prepare('SELECT id, location_id, name, code, is_active FROM registers WHERE id = ?').get(registerId) as { id: string; location_id: string; name: string; code: string | null; is_active: number } | undefined
    : undefined;
  const deviceRow = deviceId
    ? db.prepare('SELECT id, register_id, name, status FROM devices WHERE id = ?').get(deviceId) as { id: string; register_id: string | null; name: string | null; status: string } | undefined
    : undefined;

  cache = {
    organization: organizationRow ? { id: organizationRow.id, name: organizationRow.name, country: organizationRow.country } : null,
    location: locationRow ? {
      id: locationRow.id, organizationId: locationRow.organization_id, name: locationRow.name,
      code: locationRow.code, isActive: !!locationRow.is_active,
    } : null,
    register: registerRow ? {
      id: registerRow.id, locationId: registerRow.location_id, name: registerRow.name,
      code: registerRow.code, isActive: !!registerRow.is_active,
    } : null,
    device: deviceRow ? { id: deviceRow.id, registerId: deviceRow.register_id, name: deviceRow.name, status: deviceRow.status } : null,
  };
  return cache;
}

export function getOrganizationContext(): OrganizationContext | null {
  return resolve().organization;
}

export function getLocationContext(): LocationContext | null {
  return resolve().location;
}

export function getRegisterContext(): RegisterContext | null {
  return resolve().register;
}

export function getDeviceContext(): DeviceContext | null {
  return resolve().device;
}

/** Test-only, and for any future re-pairing/device-registration flow: the pointers do not change at runtime otherwise. */
export function resetContextCache(): void {
  cache = null;
}
