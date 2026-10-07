/*
 * The operator console (cloud/panel): served only when the operator API is on, with a strict CSP, and every
 * action it offers is the real /admin/v1 call - driven here in a DOM against a real listening cloud server.
 */
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { JSDOM } from 'jsdom';

const request = require('supertest');
const { SqliteCloudStore } = require('../cloud/store');
const { createCloudServer } = require('../cloud/server');

const TOKEN = 'operator-token-for-panel-test';
let checks = 0;
function ok(cond: boolean, msg: string) { assert.ok(cond, msg); checks++; console.log(`  ✓ ${msg}`); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, label: string, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return; } catch { /* keep polling */ } await sleep(30); }
  throw new Error('Timed out waiting for ' + label);
}

async function main() {
  console.log('Testing the operator console...');
  delete process.env.PLEMMO_CLOUD_ADMIN_TOKEN;
  const store = new SqliteCloudStore();
  const app = createCloudServer(store);

  console.log('\n1. served only when the operator API is on, with a strict policy');
  ok((await request(app).get('/operator')).status === 404, 'with no operator token configured the console does not exist (404)');
  process.env.PLEMMO_CLOUD_ADMIN_TOKEN = TOKEN;
  process.env.PLEMMO_CLOUD_PUBLIC_URL = 'https://cloud.example.test';
  const page = await request(app).get('/operator');
  ok(page.status === 200 && /text\/html/.test(page.headers['content-type']), 'the page is served once the operator API is on');
  const csp = String(page.headers['content-security-policy']);
  ok(/default-src 'none'/.test(csp) && /script-src 'self'/.test(csp) && !/unsafe-inline|unsafe-eval/.test(csp) && /frame-ancestors 'none'/.test(csp), 'a strict content security policy: own scripts only, no inline code, never framed');
  ok(page.headers['cache-control'] === 'no-store' && page.headers['x-content-type-options'] === 'nosniff', 'never cached, no type sniffing');
  ok(!/<script>[^<]|onclick=|style=/.test(page.text), 'the page has no inline script or style');
  ok((await request(app).get('/operator/panel.js')).status === 200 && (await request(app).get('/operator/panel.css')).status === 200, 'its script and stylesheet are served');
  ok(!/(Plemmo|Meridian|FloCafe)/i.test(page.text), 'no brand is hard-wired into the page');

  console.log('\n2. driving it in a browser DOM');
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  await fetch(origin + '/admin/v1/plans/retail', { method: 'PUT', headers: auth, body: JSON.stringify({ name: 'Retail', features: ['core.pos', 'retail.catalog'], device_limit: 2, location_limit: 1, grace_days: 14, term_days: 365 }) });
  await fetch(origin + '/admin/v1/plans/pro', { method: 'PUT', headers: auth, body: JSON.stringify({ name: 'Pro', features: ['core.pos', 'retail.catalog', 'retail.inventory'], device_limit: 5, location_limit: 3, grace_days: 14, term_days: 365 }) });

  const dom = await JSDOM.fromURL(origin + '/operator', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w: any) { w.fetch = (u: any, i?: any) => fetch(new URL(u, origin), i); w.confirm = () => true; w.prompt = () => 'Unpaid invoice'; },
  });
  const w: any = dom.window; const doc = w.document;
  const text = () => doc.getElementById('app').textContent || '';
  const byText = (sel: string, t: string) => Array.from(doc.querySelectorAll(sel)).find((e: any) => (e.textContent || '').trim() === t) as any;
  await waitFor(() => !!doc.querySelector('input[type=password]'), 'sign-in form');
  ok(/Sign in/.test(text()), 'it asks for the operator token');
  const tokenInput = doc.querySelector('input[type=password]') as any;
  tokenInput.value = 'wrong-token'; byText('button', 'Continue').click();
  await waitFor(() => /not accepted/.test(text()), 'bad token message');
  ok(!!doc.querySelector('input[type=password]'), 'a wrong token is refused and the sign-in stays');
  (doc.querySelector('input[type=password]') as any).value = TOKEN; byText('button', 'Continue').click();
  await waitFor(() => /New merchant/.test(text()), 'merchants view');
  ok(w.sessionStorage.getItem('operator_token') === TOKEN && !doc.getElementById('signout').hidden, 'signed in; the token is held for this tab only');

  const inputs = () => Array.from(doc.querySelectorAll('input')) as any[];
  const nameBox = inputs().find((i) => i.placeholder === 'Business name');
  nameBox.value = 'Corner <b>Shop</b>';
  inputs().find((i) => i.placeholder === 'Contact email (optional)').value = 'owner@example.test';
  byText('button', 'Create').click();
  await waitFor(() => /Licence/.test(text()) && /MRC-/.test(text()), 'merchant detail');
  ok(/Corner <b>Shop<\/b>/.test(text()) && !doc.querySelector('#app b'), 'the new merchant is created and its name is shown as text, never as markup');
  const code = (text().match(/MRC-[0-9A-Z]{4}-[0-9A-Z]{4}/) || [''])[0];
  ok(!!code, `the merchant has a human-readable code (${code})`);
  ok((await (await fetch(origin + '/admin/v1/merchants/' + code, { headers: auth })).json()).merchant.name === 'Corner <b>Shop</b>', 'and it really exists on the server');

  byText('button', 'Issue activation code').click();
  await waitFor(() => /works once/.test(text()), 'activation code');
  const shown = String(doc.querySelector('.code .mono').textContent);
  ok(shown.includes('~') && Buffer.from(shown.split('~')[0], 'base64url').toString() === 'https://cloud.example.test', 'an activation code carrying the cloud address is shown to hand over');

  byText('button', 'Suspend').click();
  await waitFor(() => !!doc.querySelector('.badge.warn'), 'suspended');
  const afterSuspend = await (await fetch(origin + '/admin/v1/merchants/' + code, { headers: auth })).json();
  ok(afterSuspend.merchant.status === 'suspended' && afterSuspend.license.status === 'suspended', 'suspend moves the merchant and its licence together (reason asked first)');
  ok(byText('button', 'Issue activation code').disabled === true, 'a suspended merchant cannot be given an activation code');
  byText('button', 'Reactivate').click();
  await waitFor(() => !byText('button', 'Reactivate') || byText('button', 'Reactivate').disabled, 'reactivated');
  ok((await (await fetch(origin + '/admin/v1/merchants/' + code, { headers: auth })).json()).merchant.status === 'active', 'reactivate restores it');

  const before = (await (await fetch(origin + '/admin/v1/merchants/' + code, { headers: auth })).json()).license.expires_at;
  inputs().find((i) => i.getAttribute('aria-label') === 'Renew days').value = '30';
  byText('button', 'Renew (days)').click();
  await waitFor(() => true, 'renew', 10); await sleep(400);
  const renewed = (await (await fetch(origin + '/admin/v1/merchants/' + code, { headers: auth })).json()).license.expires_at;
  ok(Date.parse(renewed) - Date.parse(before) === 30 * 86400000, 'renew adds exactly 30 days to the paid-up expiry');
  const planSel = Array.from(doc.querySelectorAll('select')).find((s: any) => s.getAttribute('aria-label') === 'New plan') as any;
  planSel.value = 'pro'; byText('button', 'Change plan').click(); await sleep(400);
  const changed = await (await fetch(origin + '/admin/v1/merchants/' + code, { headers: auth })).json();
  ok(changed.merchant.plan_id === 'pro' && changed.license.device_limit === 5, 'change plan re-derives the licence limits');

  console.log('\n3. plans');
  byText('button', '← All merchants').click(); await waitFor(() => /New merchant/.test(text()), 'back to the list');
  byText('.tabs button', 'Plans').click(); await waitFor(() => /New plan/.test(text()), 'plans view');
  ok(/Retail/.test(text()) && /Pro/.test(text()), 'both plans are listed');
  const editBtn = Array.from(doc.querySelectorAll('button')).filter((b: any) => b.textContent === 'Edit')[0] as any; editBtn.click();
  await waitFor(() => /Edit plan/.test(text()), 'plan editor');
  const devBox = inputs().find((i) => i.getAttribute('aria-label') === 'Device limit'); devBox.value = '9';
  byText('button', 'Save').click(); await sleep(400);
  const plans = (await (await fetch(origin + '/admin/v1/plans', { headers: auth })).json()).plans;
  ok(plans.some((p: any) => p.device_limit === 9), 'a plan edit is saved on the server');

  console.log('\n4. closing and signing out');
  byText('.tabs button', 'Merchants').click(); await waitFor(() => /New merchant/.test(text()), 'merchants');
  Array.from(doc.querySelectorAll('tr.click'))[0] && (Array.from(doc.querySelectorAll('tr.click'))[0] as any).click();
  await waitFor(() => /Close for good/.test(text()), 'merchant again');
  byText('button', 'Close for good').click(); await sleep(500);
  ok((await (await fetch(origin + '/admin/v1/merchants/' + code, { headers: auth })).json()).license.status === 'revoked', 'closing revokes the licence (after a confirmation)');
  doc.getElementById('signout').click();
  await waitFor(() => !!doc.querySelector('input[type=password]'), 'signed out');
  ok(w.sessionStorage.getItem('operator_token') == null, 'signing out forgets the token');

  w.close(); server.close();
  console.log(`\n✅ Operator console passed (${checks} checks)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
