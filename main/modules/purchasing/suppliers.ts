/**
 * Supplier management (Milestone 5, Part C). A supplier is primarily a
 * purchasing relationship, not an accounting entity — no ledger, no payment
 * terms, no accounts-payable concept lives here.
 */

import { getDatabase, now } from '../../db';
import { ulid } from '../../core/ids';
import { getCurrentOrganizationId } from '../../core/location';

export class SupplierError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'SupplierError';
    this.statusCode = statusCode;
  }
}

export interface SupplierInput {
  name: string;
  businessName?: string | null;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  taxRegistrationNumber?: string | null;
  isActive?: boolean;
}

function validate(input: SupplierInput): void {
  if (!input.name || !input.name.trim()) {
    throw new SupplierError('Supplier name is required');
  }
}

/** Suppliers sharing a name are permitted — two real businesses can share one; this is not an identity key. */
export function createSupplier(input: SupplierInput): any {
  validate(input);
  const db = getDatabase();
  const id = ulid();
  const timestamp = now();
  db.prepare(`
    INSERT INTO suppliers
      (id, organization_id, name, business_name, contact_person, phone, email, address, notes, tax_registration_number, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, getCurrentOrganizationId(), input.name.trim(), input.businessName || null, input.contactPerson || null,
    input.phone || null, input.email || null, input.address || null, input.notes || null,
    input.taxRegistrationNumber || null, input.isActive === false ? 0 : 1, timestamp, timestamp,
  );
  return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
}

export function updateSupplier(id: string, input: Partial<SupplierInput>): any {
  const db = getDatabase();
  const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as any;
  if (!existing) {
    throw new SupplierError(`Supplier ${id} not found`, 404);
  }
  if (input.name !== undefined && !input.name.trim()) {
    throw new SupplierError('Supplier name cannot be blank');
  }

  const next = {
    name: input.name !== undefined ? input.name.trim() : existing.name,
    business_name: input.businessName !== undefined ? input.businessName : existing.business_name,
    contact_person: input.contactPerson !== undefined ? input.contactPerson : existing.contact_person,
    phone: input.phone !== undefined ? input.phone : existing.phone,
    email: input.email !== undefined ? input.email : existing.email,
    address: input.address !== undefined ? input.address : existing.address,
    notes: input.notes !== undefined ? input.notes : existing.notes,
    tax_registration_number: input.taxRegistrationNumber !== undefined ? input.taxRegistrationNumber : existing.tax_registration_number,
    is_active: input.isActive !== undefined ? (input.isActive ? 1 : 0) : existing.is_active,
  };

  db.prepare(`
    UPDATE suppliers SET name = ?, business_name = ?, contact_person = ?, phone = ?, email = ?, address = ?, notes = ?, tax_registration_number = ?, is_active = ?, updated_at = ?
    WHERE id = ?
  `).run(next.name, next.business_name, next.contact_person, next.phone, next.email, next.address, next.notes, next.tax_registration_number, next.is_active, now(), id);

  return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
}

export function getSupplier(id: string): any {
  return getDatabase().prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
}

export function listSuppliers(opts: { search?: string; activeOnly?: boolean } = {}): any[] {
  const db = getDatabase();
  const wheres: string[] = [];
  const params: any[] = [];
  if (opts.activeOnly) {
    wheres.push('is_active = 1');
  }
  if (opts.search) {
    wheres.push('(name LIKE ? OR business_name LIKE ? OR contact_person LIKE ?)');
    const term = `%${opts.search}%`;
    params.push(term, term, term);
  }
  const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM suppliers ${where} ORDER BY name ASC`).all(...params) as any[];
}

export function deactivateSupplier(id: string): void {
  const db = getDatabase();
  const existing = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(id);
  if (!existing) {
    throw new SupplierError(`Supplier ${id} not found`, 404);
  }
  db.prepare('UPDATE suppliers SET is_active = 0, updated_at = ? WHERE id = ?').run(now(), id);
}
