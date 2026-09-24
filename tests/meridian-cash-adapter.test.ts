/*
 * Payments + Cash phase — Meridian cash/tips adapter (client shaping) test.
 * Loads the real adapter with a stub PlemmoAPI that records requests, and
 * asserts it builds the correct request bodies + endpoints for the Plemmo API.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }

const calls: any[] = [];
const stubApi = {
  get: (p: string) => { calls.push({ m: 'GET', p }); return Promise.resolve({}); },
  post: (p: string, body: any, opts: any) => { calls.push({ m: 'POST', p, body, opts }); return Promise.resolve({ ok: true }); },
};
const sandbox: any = { window: { PlemmoAPI: stubApi } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'frontend-meridian', 'src', '03e-plemmo-cash.js'), 'utf8'), sandbox);
const Cash = sandbox.window.PlemmoCash;
const Pay = sandbox.window.PlemmoPayments;

async function run() {
  console.log('Testing Meridian cash/tips adapter (client shaping)...');

  // Pure helper mirrors the backend.
  assert(Cash.denominationTotal({ '5000': 2, '2000': 2, '1000': 1 }) === 15000, 'denominationTotal £150');
  assert(Cash.denominationTotal(null) === 0, 'denominationTotal null → 0');

  const last = () => calls[calls.length - 1];

  await Cash.open({ openingCounts: { '5000': 2 } });
  assert(last().p === '/cash/session/open' && last().body.opening_counts['5000'] === 2 && last().opts.idempotent === true, 'open sends counts + idempotent');

  await Cash.open({ openingFloatMinor: 15000 });
  assert(last().body.opening_float_minor === 15000, 'open sends float when no counts');

  await Cash.payIn('sess1', 2000, 'change');
  assert(last().p === '/cash/session/sess1/movement' && last().body.type === 'pay_in' && last().body.amount_minor === 2000, 'payIn shapes movement');

  await Cash.noSale('sess1');
  assert(last().body.type === 'no_sale' && last().body.amount_minor === 0, 'noSale is a zero movement');

  await Cash.close('sess1', { countedMinor: 17500 });
  assert(last().p === '/cash/session/sess1/close' && last().body.counted_minor === 17500, 'close sends counted');

  await Pay.pay('bill9', { method: 'cash', amount: 10, tip: 2, tendered: 15 });
  assert(last().p === '/bills/bill9/payment' && last().body.tip === 2 && last().body.tendered === 15 && last().opts.idempotent === true, 'pay sends tip + tendered + idempotent');

  await Pay.paySplit('bill9', [{ method: 'cash', amount: 5 }, { method: 'card', amount: 5, tip: 1 }]);
  assert(last().p === '/bills/bill9/payments' && last().body.payments.length === 2, 'paySplit sends payment array');

  console.log('✅ Meridian cash/tips adapter tests passed');
}

run().catch((err) => { console.error(err); process.exit(1); });
