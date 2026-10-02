import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { getDatabase, now, withTxn } from '../db';
import { requireRole } from '../middleware/security';
import { randomUUID } from 'crypto';
import { validateItemNotes, validateOrderNotes } from '../core/notes-validation';

const router = Router();

const TABLE_STATUS_HELD = 'held';
const TABLE_STATUS_AVAILABLE = 'available';

interface HeldOrderRow {
  id: string;
  table_id: string;
  items: string;
  customer_id: string | null;
  guest_count: number;
  order_notes: string | null;
  created_at: string;
  updated_at: string;
}

const MAX_HELD_ORDER_ITEMS = 100;
const MAX_IDENTIFIER_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidIdentifier(value: unknown): value is string | number {
  return (typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_IDENTIFIER_LENGTH)
    || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

function validateHeldOrderItem(item: unknown, db: any): void {
  if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0 || item.id.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error('Each held-order item must have a valid id');
  }
  if (!isRecord(item.product) || !isValidIdentifier(item.product.id)) {
    throw new Error('Each held-order item must have a valid product');
  }
  if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
    throw new Error('Each held-order item must have a positive integer quantity');
  }
  if (!Array.isArray(item.addons) || item.addons.some((addon: unknown) => !isRecord(addon) || !isValidIdentifier(addon.id))) {
    throw new Error('Held-order item addons must be an array of valid addons');
  }
  if (item.special_instructions !== undefined && typeof item.special_instructions !== 'string') {
    throw new Error('Item special instructions must be a string');
  }
  validateItemNotes(db, item.special_instructions);
}

function validateHeldOrderInput(body: any, db: any): {
  tableId: string;
  items: unknown[];
  customerId: string | number | null;
  guestCount: number;
  orderNotes: string;
} {
  if (!isRecord(body)) {
    throw new Error('Request body must be an object');
  }
  const { tableId, items, customerId, guestCount, orderNotes } = body;
  if (typeof tableId !== 'string' || tableId.trim().length === 0 || tableId.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error('tableId must be a non-empty string');
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_HELD_ORDER_ITEMS) {
    throw new Error(`items must contain between 1 and ${MAX_HELD_ORDER_ITEMS} items`);
  }
  items.forEach((item) => validateHeldOrderItem(item, db));
  if (customerId !== undefined && customerId !== null && !isValidIdentifier(customerId)) {
    throw new Error('customerId must be a valid identifier');
  }
  if (guestCount !== undefined && (!Number.isSafeInteger(guestCount) || guestCount <= 0)) {
    throw new Error('guestCount must be a positive integer');
  }
  if (orderNotes !== undefined && orderNotes !== null && typeof orderNotes !== 'string') {
    throw new Error('orderNotes must be a string');
  }
  validateOrderNotes(db, orderNotes);
  return {
    tableId,
    items,
    customerId: customerId ?? null,
    guestCount: guestCount ?? 1,
    orderNotes: orderNotes ?? '',
  };
}

function parseStoredHeldOrder(row: HeldOrderRow): Record<string, unknown> | null {
  try {
    const items = JSON.parse(row.items);
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_HELD_ORDER_ITEMS || items.some((item) => !isRecord(item))) {
      return null;
    }
    return {
      id: row.id,
      tableId: row.table_id,
      items,
      customerId: row.customer_id,
      guestCount: Number.isSafeInteger(row.guest_count) && row.guest_count > 0 ? row.guest_count : 1,
      orderNotes: row.order_notes || '',
      heldAt: row.created_at,
    };
  } catch {
    return null;
  }
}

router.get('/', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM held_orders ORDER BY updated_at DESC').all() as HeldOrderRow[];
    const orders: Record<string, unknown>[] = [];
    let skippedCount = 0;
    for (const row of rows) {
      const order = parseStoredHeldOrder(row);
      if (order) orders.push(order);
      else {
        skippedCount++;
        console.warn(`[API] Skipping malformed held order ${row.id}`);
      }
    }
    res.json({ orders, skippedCount });
  } catch (error: any) {
    console.error("[API] Held orders fetch error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    let input;
    try {
      input = validateHeldOrderInput(req.body, db);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
    const { tableId, items, customerId, guestCount, orderNotes } = input;
    
    withTxn(() => {
      const existing = db.prepare('SELECT id FROM held_orders WHERE table_id = ?').get(tableId) as { id: string } | undefined;
      
      if (existing) {
        db.prepare(`
          UPDATE held_orders
          SET items = ?, customer_id = ?, guest_count = ?, order_notes = ?, updated_at = ?
          WHERE id = ?
        `).run(JSON.stringify(items), customerId || null, guestCount || 1, orderNotes || '', now(), existing.id);
      } else {
        const id = `ho-${randomUUID().slice(0, 8)}`;
        db.prepare(`
          INSERT INTO held_orders (id, table_id, items, customer_id, guest_count, order_notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, tableId, JSON.stringify(items), customerId || null, guestCount || 1, orderNotes || '', now(), now());
      }

      db.prepare('UPDATE tables SET status = ?, updated_at = ? WHERE id = ?').run(TABLE_STATUS_HELD, now(), tableId);
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error("[API] Hold order error:", error);
    res.status(500).json({ error: "Could not hold order" });
  }
});

// ── Held carts (counter / retail parking) ───────────────────────────────────
//
// The routes above park a TABLE's order (one per table). A till also parks
// ordinary counter carts that have no table and several at once, so those live
// in `held_carts` (migration v96). A held cart is not a sale: it has no totals,
// no stock effect and no sync footprint until it is resumed and rung up.
//
//   POST   /held-orders/carts               park (or update) a cart, keyed by the client-supplied id
//   GET    /held-orders/carts               list parked carts
//   POST   /held-orders/carts/:id/resume    take a cart back — returns it AND removes it in one step,
//                                           so two terminals can never both resume the same cart
//   DELETE /held-orders/carts/:id           discard
const heldCartRateLimit = expressRateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many held-cart requests. Slow down and try again shortly.' },
});
const MAX_CART_JSON_BYTES = 200_000;
const MAX_HELD_CARTS = 200;
const CART_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validateHeldCart(cart: unknown): string | null {
  if (!isRecord(cart)) return 'cart must be an object';
  if (!Array.isArray(cart.items) || cart.items.length === 0 || cart.items.length > MAX_HELD_ORDER_ITEMS) {
    return `cart.items must contain between 1 and ${MAX_HELD_ORDER_ITEMS} lines`;
  }
  for (const line of cart.items) {
    if (!isRecord(line)) return 'each cart line must be an object';
    if (!isValidIdentifier(line.pid)) return 'each cart line needs a product id';
    if (!Number.isSafeInteger(line.qty) || line.qty <= 0) return 'each cart line needs a positive whole quantity';
  }
  return null;
}

function heldCartShape(row: { id: string; label: string; cart_json: string; created_by: string | null; created_at: string; updated_at: string }) {
  let cart: unknown = null;
  try { cart = JSON.parse(row.cart_json); } catch { cart = null; }
  return { id: row.id, label: row.label, cart, heldBy: row.created_by, heldAt: row.created_at };
}

router.get('/carts', heldCartRateLimit, requireRole('owner', 'manager', 'cashier', 'waiter'), (_req: Request, res: Response) => {
  try {
    const rows = getDatabase().prepare('SELECT * FROM held_carts ORDER BY created_at ASC').all() as any[];
    res.json({ carts: rows.map(heldCartShape).filter((c) => c.cart) });
  } catch (error: any) {
    console.error('[API] Held carts fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/carts', heldCartRateLimit, requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const { id, label, cart } = req.body || {};
    if (typeof id !== 'string' || !CART_ID_RE.test(id)) return res.status(400).json({ error: 'id must be 1-64 letters, digits, - or _' });
    const problem = validateHeldCart(cart);
    if (problem) return res.status(400).json({ error: problem });
    const cartJson = JSON.stringify(cart);
    if (Buffer.byteLength(cartJson) > MAX_CART_JSON_BYTES) return res.status(400).json({ error: 'cart is too large' });
    const cleanLabel = (typeof label === 'string' && label.trim() ? label.trim() : 'Held order').slice(0, 80);
    const userId = String((req as any).user?.userId ?? '');
    const db = getDatabase();
    const created = withTxn(() => {
      const existing = db.prepare('SELECT id FROM held_carts WHERE id = ?').get(id);
      if (existing) {
        db.prepare('UPDATE held_carts SET label = ?, cart_json = ?, updated_at = ? WHERE id = ?').run(cleanLabel, cartJson, now(), id);
        return false;
      }
      const count = (db.prepare('SELECT COUNT(*) AS n FROM held_carts').get() as { n: number }).n;
      if (count >= MAX_HELD_CARTS) throw Object.assign(new Error('Too many held orders. Resume or discard some first.'), { statusCode: 409 });
      db.prepare('INSERT INTO held_carts (id, label, cart_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, cleanLabel, cartJson, userId || null, now(), now());
      return true;
    });
    res.status(created ? 201 : 200).json({ success: true, id, created });
  } catch (error: any) {
    if (error?.statusCode === 409) return res.status(409).json({ error: error.message });
    console.error('[API] Hold cart error:', error);
    res.status(500).json({ error: 'Could not hold the order' });
  }
});

router.post('/carts/:id/resume', heldCartRateLimit, requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const row = withTxn(() => {
      const found = db.prepare('SELECT * FROM held_carts WHERE id = ?').get(req.params.id) as any;
      if (found) db.prepare('DELETE FROM held_carts WHERE id = ?').run(req.params.id);
      return found;
    });
    if (!row) return res.status(404).json({ error: 'That held order is no longer available' });
    res.json(heldCartShape(row));
  } catch (error: any) {
    console.error('[API] Resume held cart error:', error);
    res.status(500).json({ error: 'Could not resume the held order' });
  }
});

router.delete('/carts/:id', heldCartRateLimit, requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const result = getDatabase().prepare('DELETE FROM held_carts WHERE id = ?').run(req.params.id);
    res.json({ success: true, deleted: result.changes > 0 });
  } catch (error: any) {
    console.error('[API] Discard held cart error:', error);
    res.status(500).json({ error: 'Could not discard the held order' });
  }
});

router.delete('/:tableId', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const tableId = req.params.tableId;
    const db = getDatabase();
    
    let deleted = false;
    withTxn(() => {
      const existing = db.prepare('SELECT id FROM held_orders WHERE table_id = ?').get(tableId);
      if (existing) {
        db.prepare('DELETE FROM held_orders WHERE table_id = ?').run(tableId);
        db.prepare('UPDATE tables SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(TABLE_STATUS_AVAILABLE, now(), tableId, TABLE_STATUS_HELD);
        deleted = true;
      }
    });

    // Deletion is intentionally idempotent. A held order may have been resumed
    // or deleted by another terminal between the UI's last refresh and this
    // request; that is already the desired end state, not an application error.
    res.json({ success: true, deleted });
  } catch (error: any) {
    console.error("[API] Delete held order error:", error);
    res.status(500).json({ error: "Could not delete held order" });
  }
});

export const heldOrderRoutes = router;
