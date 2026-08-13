/**
 * Retail's Product → ProductVariant layer (Milestone 3).
 *
 * A hospitality product never touches this file — it is sold directly off
 * `products`, exactly as before this milestone. A retail product that needs
 * distinct SKUs/barcodes/prices per option (size, colour, storage) gets one
 * `product_variants` row per option, created and looked up through the
 * functions here.
 *
 * See docs/MILESTONE_3_VERTICALS_AND_RETAIL.md § Product/Variant schema.
 */

import { getDatabase, now } from '../../db';
import { ulid } from '../../core/ids';

export class RetailError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface ProductVariantInput {
  productId: string;
  name?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price: number;
  cost?: number | null;
  taxCategoryId?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
  sortOrder?: number;
}

function validateVariantInput(input: ProductVariantInput): void {
  if (!input.productId) {
    throw new RetailError('product_id is required');
  }
  if (typeof input.price !== 'number' || !Number.isFinite(input.price) || input.price < 0) {
    throw new RetailError('price must be a non-negative number');
  }
  if (input.cost != null && (typeof input.cost !== 'number' || !Number.isFinite(input.cost) || input.cost < 0)) {
    throw new RetailError('cost must be a non-negative number');
  }
  if (input.sku != null && typeof input.sku !== 'string') {
    throw new RetailError('sku must be a string');
  }
  if (input.barcode != null && typeof input.barcode !== 'string') {
    throw new RetailError('barcode must be a string');
  }
}

/**
 * Creates a variant. SKU/barcode uniqueness is enforced by the database's
 * partial unique indexes (migration v72) — a collision surfaces here as a
 * SQLITE_CONSTRAINT error, which is translated into a 409 so the route
 * doesn't need to know SQLite error codes.
 */
export function createVariant(input: ProductVariantInput): any {
  validateVariantInput(input);
  const db = getDatabase();

  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(input.productId);
  if (!product) {
    throw new RetailError(`Product ${input.productId} not found`, 404);
  }

  const id = ulid();
  const timestamp = now();
  try {
    db.prepare(`
      INSERT INTO product_variants
        (id, product_id, name, sku, barcode, price, cost, tax_category_id, is_default, is_active, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.productId, input.name || null, input.sku || null, input.barcode || null,
      input.price, input.cost ?? 0, input.taxCategoryId || null,
      input.isDefault ? 1 : 0, input.isActive === false ? 0 : 1, input.sortOrder ?? 0,
      timestamp, timestamp,
    );
  } catch (error: any) {
    if (String(error?.code) === 'SQLITE_CONSTRAINT_UNIQUE' || String(error?.message || '').includes('UNIQUE constraint failed')) {
      throw new RetailError('A variant with that SKU or barcode already exists', 409);
    }
    throw error;
  }

  return db.prepare('SELECT * FROM product_variants WHERE id = ?').get(id);
}

export function listVariantsForProduct(productId: string): any[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order ASC, created_at ASC').all(productId);
}

export function getVariant(id: string): any {
  const db = getDatabase();
  return db.prepare('SELECT * FROM product_variants WHERE id = ?').get(id);
}

export interface VariantUpdateInput {
  name?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price?: number;
  cost?: number | null;
  taxCategoryId?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
  sortOrder?: number;
}

export function updateVariant(id: string, input: VariantUpdateInput): any {
  const db = getDatabase();
  const existing = db.prepare('SELECT * FROM product_variants WHERE id = ?').get(id) as any;
  if (!existing) {
    throw new RetailError(`Variant ${id} not found`, 404);
  }
  if (input.price !== undefined && (typeof input.price !== 'number' || !Number.isFinite(input.price) || input.price < 0)) {
    throw new RetailError('price must be a non-negative number');
  }

  const next = {
    name: input.name !== undefined ? input.name : existing.name,
    sku: input.sku !== undefined ? input.sku : existing.sku,
    barcode: input.barcode !== undefined ? input.barcode : existing.barcode,
    price: input.price !== undefined ? input.price : existing.price,
    cost: input.cost !== undefined ? input.cost : existing.cost,
    tax_category_id: input.taxCategoryId !== undefined ? input.taxCategoryId : existing.tax_category_id,
    is_default: input.isDefault !== undefined ? (input.isDefault ? 1 : 0) : existing.is_default,
    is_active: input.isActive !== undefined ? (input.isActive ? 1 : 0) : existing.is_active,
    sort_order: input.sortOrder !== undefined ? input.sortOrder : existing.sort_order,
  };

  try {
    db.prepare(`
      UPDATE product_variants
      SET name = ?, sku = ?, barcode = ?, price = ?, cost = ?, tax_category_id = ?, is_default = ?, is_active = ?, sort_order = ?, updated_at = ?
      WHERE id = ?
    `).run(next.name, next.sku, next.barcode, next.price, next.cost, next.tax_category_id, next.is_default, next.is_active, next.sort_order, now(), id);
  } catch (error: any) {
    if (String(error?.code) === 'SQLITE_CONSTRAINT_UNIQUE' || String(error?.message || '').includes('UNIQUE constraint failed')) {
      throw new RetailError('A variant with that SKU or barcode already exists', 409);
    }
    throw error;
  }

  return db.prepare('SELECT * FROM product_variants WHERE id = ?').get(id);
}

export function deactivateVariant(id: string): void {
  const db = getDatabase();
  const existing = db.prepare('SELECT id FROM product_variants WHERE id = ?').get(id);
  if (!existing) {
    throw new RetailError(`Variant ${id} not found`, 404);
  }
  db.prepare('UPDATE product_variants SET is_active = 0, updated_at = ? WHERE id = ?').run(now(), id);
}

export interface LookupResult {
  kind: 'variant' | 'product';
  product: any;
  variant: any | null;
}

/**
 * Scanner/search entry point (B3). Tries an exact variant barcode or SKU
 * match first (a variant is the more specific match when both could apply),
 * then falls back to the bare product's own barcode/SKU — the path every
 * existing hospitality/retail product without variants already has.
 */
export function lookupByCode(code: string): LookupResult | null {
  const db = getDatabase();
  const trimmed = (code || '').trim();
  if (!trimmed) return null;

  const variant = db.prepare('SELECT * FROM product_variants WHERE (barcode = ? OR sku = ?) AND is_active = 1')
    .get(trimmed, trimmed) as any;
  if (variant) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(variant.product_id);
    if (product) return { kind: 'variant', product, variant };
  }

  const product = db.prepare("SELECT * FROM products WHERE (barcode = ? OR sku = ?) AND deleted_at IS NULL AND is_active = 1")
    .get(trimmed, trimmed) as any;
  if (product) return { kind: 'product', product, variant: null };

  return null;
}
