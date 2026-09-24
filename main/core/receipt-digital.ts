/**
 * Digital receipts (Meridian integration). Assembles an AUTHORITATIVE receipt
 * payload from the bill/order/items/payments/settings and renders a plain-text
 * version for display, QR or email. Delivery requests are recorded (auditable);
 * the desktop build has no mail transport, so nothing is silently "sent".
 */
import { getDatabase, now, getSettingValue } from '../db';
import { ulid } from './ids';
import { recordAuditEvent } from './audit';

export interface DigitalReceiptLine { name: string; quantity: number; unit_price: number; total: number; addons?: string[]; note?: string | null }
export interface DigitalReceipt {
  bill_id: number;
  bill_number: string | null;
  order_number: string | null;
  business: { name: string; address: string; phone: string; vat: string; currency: string };
  type: string | null;
  items: DigitalReceiptLine[];
  subtotal: number;
  discount: number;
  tax: number;
  tax_breakdown: unknown;
  round_off: number;
  total: number;
  paid: number;
  balance: number;
  tip: number;
  payments: Array<{ method: string; amount: number; tip?: number }>;
  footer: string;
  created_at: string;
  text: string;
}

function parseJson<T>(v: unknown, fallback: T): T { try { return v ? JSON.parse(String(v)) as T : fallback; } catch { return fallback; } }

export function buildDigitalReceipt(billId: number | string): DigitalReceipt {
  const db = getDatabase();
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as any;
  if (!bill) { const e: any = new Error('Bill not found'); e.statusCode = 404; throw e; }
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(bill.order_id) as any;
  const itemRows = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(bill.order_id) as any[];

  const s = (k: string, d = '') => getSettingValue(k) || d;
  const currency = s('currency', 'INR');
  const items: DigitalReceiptLine[] = itemRows.map((i) => {
    const addons = parseJson<any[]>(i.addons, []).map((a) => a && (a.name || a)).filter(Boolean);
    return { name: i.product_name, quantity: i.quantity, unit_price: i.unit_price, total: i.total,
      addons: addons.length ? addons : undefined, note: i.special_instructions || null };
  });

  const payments = parseJson<any[]>(bill.payment_details, []).map((p) => ({ method: p.method, amount: Number(p.amount) || 0, tip: Number(p.tip) || 0 }));
  // Tips are authoritative on the payments table (tip_minor).
  const tipRow = db.prepare(`SELECT COALESCE(SUM(tip_minor),0) AS t FROM payments WHERE bill_id = ?`).get(billId) as { t: number };
  const tip = (tipRow.t || 0) / 100;

  const receipt: DigitalReceipt = {
    bill_id: Number(bill.id),
    bill_number: bill.bill_number || null,
    order_number: order ? order.order_number : null,
    business: { name: s('business_name', 'Store'), address: s('address'), phone: s('phone'), vat: s('vat_number') || s('vatNo'), currency },
    type: order ? order.type : null,
    items,
    subtotal: Number(bill.subtotal) || 0,
    discount: Number(bill.discount_amount) || 0,
    tax: Number(bill.tax_amount) || 0,
    tax_breakdown: parseJson(bill.tax_breakdown, null),
    round_off: Number(bill.round_off) || 0,
    total: Number(bill.total) || 0,
    paid: Number(bill.paid_amount) || 0,
    balance: Number(bill.balance) || 0,
    tip,
    payments,
    footer: s('receipt_footer', 'Thank you'),
    created_at: bill.created_at || now(),
    text: '',
  };
  receipt.text = renderReceiptText(receipt);
  return receipt;
}

function money(n: number, currency: string): string {
  const sym: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', INR: '₹' };
  return (sym[currency] || '') + (Number(n) || 0).toFixed(2);
}

export function renderReceiptText(r: DigitalReceipt): string {
  const c = r.business.currency;
  const lines: string[] = [];
  lines.push(r.business.name);
  if (r.business.address) lines.push(r.business.address);
  if (r.business.phone) lines.push(r.business.phone);
  lines.push('');
  if (r.order_number) lines.push(`Order ${r.order_number}${r.type ? ' · ' + r.type : ''}`);
  if (r.bill_number) lines.push(`Bill ${r.bill_number}`);
  lines.push('--------------------------------');
  for (const it of r.items) {
    lines.push(`${it.quantity} x ${it.name}  ${money(it.total, c)}`);
    if (it.addons && it.addons.length) lines.push(`   + ${it.addons.join(', ')}`);
    if (it.note) lines.push(`   "${it.note}"`);
  }
  lines.push('--------------------------------');
  lines.push(`Subtotal        ${money(r.subtotal, c)}`);
  if (r.discount) lines.push(`Discount       -${money(r.discount, c)}`);
  if (r.tax) lines.push(`Tax             ${money(r.tax, c)}`);
  if (r.round_off) lines.push(`Rounding        ${money(r.round_off, c)}`);
  lines.push(`Total           ${money(r.total, c)}`);
  if (r.tip) lines.push(`Tip             ${money(r.tip, c)}`);
  for (const p of r.payments) lines.push(`${p.method.padEnd(15)} ${money(p.amount, c)}`);
  if (r.balance > 0) lines.push(`Balance         ${money(r.balance, c)}`);
  lines.push('');
  lines.push(r.footer);
  return lines.join('\n');
}

export function recordReceiptDelivery(input: { billId: number | string; channel: 'email' | 'sms' | 'link'; destination?: string | null; actorUserId?: string | null }): { id: string; status: string } {
  const db = getDatabase();
  const id = ulid();
  db.prepare(`INSERT INTO receipt_deliveries (id, bill_id, channel, destination, status, actor_user_id, created_at) VALUES (?, ?, ?, ?, 'recorded', ?, ?)`)
    .run(id, input.billId, input.channel, input.destination ?? null, input.actorUserId ?? null, now());
  recordAuditEvent({ type: 'receipt.delivered', actor: { userId: input.actorUserId ?? null }, entity: { type: 'receipt_delivery', id },
    summary: `Digital receipt ${input.channel} requested for bill ${input.billId}`, metadata: { bill_id: Number(input.billId), channel: input.channel } });
  return { id, status: 'recorded' };
}
