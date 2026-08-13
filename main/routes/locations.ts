/**
 * Location management HTTP surface (Milestone 6, Part Q). Minimal CRUD —
 * enough for a merchant to register additional locations (needed for stock
 * transfers to have somewhere to transfer to) and see register/device
 * context. This does NOT let the current install switch which location it
 * represents — Part K is explicit that a local install stays associated
 * with exactly one physical location; see main/core/context.ts.
 */

import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/security';
import { getDatabase, now } from '../db';
import { ulid } from '../core/ids';
import { getOrganizationContext, getLocationContext, getRegisterContext, getDeviceContext } from '../core/context';
import { salesByLocation, inventoryByLocation, purchasesByLocation, transfersReport, stockAdjustmentsByLocation } from '../core/location-reports';

const router = Router();

router.get('/', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  const db = getDatabase();
  const locations = db.prepare('SELECT * FROM locations ORDER BY created_at ASC').all();
  res.json({ locations });
});

router.get('/context', requireRole('owner', 'manager', 'cashier'), (_req: Request, res: Response) => {
  res.json({
    organization: getOrganizationContext(),
    location: getLocationContext(),
    register: getRegisterContext(),
    device: getDeviceContext(),
  });
});

router.get('/reports/sales', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  res.json({ locations: salesByLocation() });
});

router.get('/reports/inventory', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  res.json({ locations: inventoryByLocation() });
});

router.get('/reports/purchases', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  res.json({ locations: purchasesByLocation() });
});

router.get('/reports/transfers', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const limit = req.query.limit ? Math.min(200, Math.max(1, Number(req.query.limit))) : 50;
  res.json({ transfers: transfersReport(limit) });
});

router.get('/reports/adjustments', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const limit = req.query.limit ? Math.min(200, Math.max(1, Number(req.query.limit))) : 50;
  res.json({ adjustments: stockAdjustmentsByLocation(limit) });
});

router.post('/', requireRole('owner'), (req: Request, res: Response) => {
  const body = req.body || {};
  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json({ error: 'Location name is required' });
  }
  const organization = getOrganizationContext();
  if (!organization) {
    return res.status(400).json({ error: 'No organization is configured on this install yet' });
  }
  const db = getDatabase();
  const id = ulid();
  const timestamp = now();
  db.prepare(`
    INSERT INTO locations (id, organization_id, name, code, address, phone, timezone, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, organization.id, String(body.name).trim(), body.code || null, body.address || null, body.phone || null, body.timezone || null, timestamp, timestamp);
  res.status(201).json({ location: db.prepare('SELECT * FROM locations WHERE id = ?').get(id) });
});

router.put('/:id', requireRole('owner'), (req: Request, res: Response) => {
  const db = getDatabase();
  const id = String(req.params.id);
  const existing = db.prepare('SELECT * FROM locations WHERE id = ?').get(id) as any;
  if (!existing) return res.status(404).json({ error: 'Location not found' });
  const body = req.body || {};
  const next = {
    name: body.name !== undefined ? String(body.name).trim() : existing.name,
    code: body.code !== undefined ? body.code : existing.code,
    address: body.address !== undefined ? body.address : existing.address,
    phone: body.phone !== undefined ? body.phone : existing.phone,
    timezone: body.timezone !== undefined ? body.timezone : existing.timezone,
    is_active: body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active,
  };
  if (!next.name) return res.status(400).json({ error: 'Location name cannot be blank' });
  db.prepare('UPDATE locations SET name = ?, code = ?, address = ?, phone = ?, timezone = ?, is_active = ?, updated_at = ? WHERE id = ?')
    .run(next.name, next.code, next.address, next.phone, next.timezone, next.is_active, now(), id);
  res.json({ location: db.prepare('SELECT * FROM locations WHERE id = ?').get(id) });
});

export const locationRoutes = router;
