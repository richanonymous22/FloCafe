/**
 * Plain-text layout of an X / Z trading report for a thermal printer. Pure: it returns the line tokens
 * ({INIT}, {CENTER}, {BOLD}, {CUT} …) that `buildEscPos` turns into printer bytes, so the layout is testable
 * without a printer. `prefix` is the already code-page-safe currency prefix (e.g. "£").
 */
import type { TradingSnapshot } from '../core/trading-report';

export interface ReportPrintMeta {
  businessName: string;
  address?: string;
  taxName: string;
  taxNumber?: string;
  prefix: string;
  number?: number;
  generatedAt?: string;
  digest?: string;
  reprint?: boolean;
  printedBy?: string;
}

export function formatTradingReport(r: TradingSnapshot, meta: ReportPrintMeta, cols: number): string[] {
  const e = r.exponent;
  const money = (minor: number): string => {
    const neg = minor < 0;
    const abs = Math.abs(minor) / Math.pow(10, e);
    return (neg ? '-' : '') + meta.prefix + abs.toFixed(e);
  };
  const bar = '='.repeat(cols);
  const thin = '-'.repeat(cols);
  const row = (label: string, value: string): string => {
    const room = cols - value.length - 1;
    const l = label.length > room ? label.slice(0, Math.max(1, room)) : label;
    return l + ' '.repeat(Math.max(1, cols - l.length - value.length)) + value;
  };
  const sec = (name: string): string[] => ['', `{BOLD}${name}{/BOLD}`, thin];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const lines: string[] = ['{INIT}'];
  lines.push(`{CENTER}{BOLD}${meta.businessName}{/BOLD}{/CENTER}`);
  if (meta.address) lines.push(`{CENTER}${meta.address}{/CENTER}`);
  if (meta.taxNumber) lines.push(`{CENTER}${meta.taxName} no. ${meta.taxNumber}{/CENTER}`);
  lines.push(bar);
  lines.push(`{CENTER}{BOLD}${r.kind === 'Z' ? `Z REPORT ${String(meta.number ?? 0).padStart(4, '0')}` : 'X REPORT - TRADING SO FAR'}{/BOLD}{/CENTER}`);
  lines.push(`{CENTER}${r.period_start}{/CENTER}`);
  lines.push(`{CENTER}to ${r.period_end} (UTC){/CENTER}`);
  if (meta.reprint) lines.push('{CENTER}*** REPRINT ***{/CENTER}');
  lines.push(bar);

  lines.push(...sec('SALES'));
  lines.push(row('Sales', String(r.transactions.count)));
  lines.push(row('Items sold', String(r.transactions.items_sold)));
  lines.push(row('Average sale', money(r.transactions.average_minor)));
  lines.push(row('Gross sales', money(r.sales.gross_minor)));
  lines.push(row(`Refunds (${r.refunds.count})`, '-' + money(r.sales.refunds_minor).replace('-', '')));
  lines.push('{BOLD}' + row('Net sales', money(r.sales.net_minor)) + '{/BOLD}');
  if (r.discounts.count) lines.push(row(`Discounts (${r.discounts.count})`, money(r.discounts.amount_minor)));

  lines.push(...sec('TAKINGS'));
  if (!r.tenders.length) lines.push('No takings');
  for (const t of r.tenders) {
    lines.push(row(`${cap(t.method)} (${t.payments})`, money(t.taken_minor)));
    if (t.refunded_minor) lines.push(row('  refunded', '-' + money(t.refunded_minor)));
    if (t.tips_minor) lines.push(row('  tips', money(t.tips_minor)));
  }
  const unverified = r.tenders.reduce((n, t) => n + (t.unverified_card_minor || 0), 0);
  if (unverified) lines.push(`${money(unverified)} of card takings were taken on a separate terminal and are not confirmed by a card provider.`);

  if (r.vat.length) {
    lines.push(...sec(`${meta.taxName} BY RATE`));
    for (const v of r.vat) {
      lines.push(row(v.label, money(v.vat_minor)));
      lines.push(row('  gross / net', `${money(v.gross_minor)} / ${money(v.net_minor)}`));
      if (v.refund_gross_minor) lines.push(row('  credit notes', '-' + money(v.refund_vat_minor)));
    }
    lines.push(row(`${meta.taxName} collected`, money(r.vat_total.vat_minor)));
    lines.push(row('Credit notes', '-' + money(r.vat_total.refund_vat_minor)));
    lines.push('{BOLD}' + row(`${meta.taxName} due`, money(r.vat_total.net_vat_minor)) + '{/BOLD}');
  }

  lines.push(...sec('OTHER'));
  lines.push(row('Voided orders', `${r.voids.orders} (${money(r.voids.orders_value_minor)})`));
  lines.push(row('Items removed after sending', String(r.voids.lines_removed)));
  lines.push(row('Price changes', String(r.voids.price_overrides)));

  lines.push(...sec('CASH DRAWER'));
  lines.push(row('Float', money(r.cash.opening_float_minor)));
  lines.push(row('Cash sales', money(r.cash.sales_minor)));
  lines.push(row('Cash refunds', '-' + money(r.cash.refunds_minor)));
  lines.push(row('Paid in', money(r.cash.pay_in_minor)));
  lines.push(row('Paid out', '-' + money(r.cash.pay_out_minor)));
  if (r.cash.sessions_closed) {
    lines.push(row('Expected', money(r.cash.expected_minor_at_close ?? 0)));
    lines.push(row('Counted', money(r.cash.counted_minor ?? 0)));
    lines.push('{BOLD}' + row('Difference', (r.cash.variance_minor ?? 0) > 0 ? '+' + money(r.cash.variance_minor ?? 0) : money(r.cash.variance_minor ?? 0)) + '{/BOLD}');
  } else if (r.checks.open_cash_session) {
    lines.push('The drawer is still open.');
  }

  lines.push(bar);
  const failed = Object.entries(r.checks).filter(([k, v]) => k !== 'open_cash_session' && v !== true).map(([k]) => k.replace(/_/g, ' '));
  lines.push(failed.length ? `CHECK FAILED: ${failed.join(', ')}. Do not rely on these figures.` : 'All totals agree (takings, tax, drawer).');
  if (r.kind === 'Z') lines.push(`Closed ${meta.generatedAt ?? ''} UTC`, `Seal ${(meta.digest ?? '').slice(0, 16)}`);
  else lines.push('Not closed. This is a read-only look.');
  if (meta.printedBy) lines.push(`Printed by ${meta.printedBy}`);
  lines.push('', '{CUT}');
  return lines;
}
