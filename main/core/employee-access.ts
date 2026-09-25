/**
 * Plemmo Core — employee location scope (Milestone 6, Part L).
 *
 * The structural foundation only: which locations a user may operate at.
 * Nothing here decides what a user may *do* once at a location — that
 * remains `users.role` + `requireRole()`, completely unchanged. No route
 * enforces this yet; it exists so a future milestone can add that
 * enforcement without another migration, per this milestone's own
 * instruction not to build a full RBAC system now.
 */

import { getDatabase, now } from '../db';

export function grantLocationAccess(userId: string, locationId: string): void {
  const db = getDatabase();
  db.prepare('INSERT OR IGNORE INTO user_locations (user_id, location_id, created_at) VALUES (?, ?, ?)')
    .run(userId, locationId, now());
}

export function revokeLocationAccess(userId: string, locationId: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM user_locations WHERE user_id = ? AND location_id = ?').run(userId, locationId);
}

export function listUserLocations(userId: string): any[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT l.* FROM locations l
    JOIN user_locations ul ON ul.location_id = l.id
    WHERE ul.user_id = ?
    ORDER BY l.name ASC
  `).all(userId) as any[];
}

export function userHasLocationAccess(userId: string, locationId: string): boolean {
  const db = getDatabase();
  const row = db.prepare('SELECT 1 FROM user_locations WHERE user_id = ? AND location_id = ?').get(userId, locationId);
  return !!row;
}
