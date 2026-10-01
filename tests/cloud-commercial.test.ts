/*
 * Plemmo Cloud — the commercial layer: plan catalogue, merchants, human-readable codes, and the licence
 * lifecycle an operator runs (create, suspend, reactivate, change plan, renew, close, replace a terminal).
 * Over real HTTP against the in-memory SqliteCloudStore; no Postgres needed.
 */
import * as assert from 'node:assert/strict';

const request = require('supertest');
const { SqliteCloudStore } = require('../cloud/store');
const { createCloudServer } = require('../cloud/server');
const { generateMerchantCode, normaliseMerchantCode, parsePlan, licenceFromPlan } = require('../cloud/commercial');

const TOKEN = 'test-operator-token-commercial';
const auth = { Authorization: `Bearer ${TOKEN}` };
let checks = 0;
function ok(cond: boolean, msg: string) { assert.ok(cond, msg); checks++; console.log(`  ✓ ${msg}`); }

async function suite(store: any, label: string, auditKinds: () => Promise<string[]>) {
  console.log(`\nTesting Plemmo Cloud commercial layer on ${label}...`);
  const app = createCloudServer(store);
  const api = (method: 'get' | 'post' | 'put', p: string, body?: any, headers = auth) => { const r = (request(app) as any)[method](p).set(headers); return body === undefined ? r : r.send(body); };

  console.log('\n1. human-readable merchant codes');
  const code = generateMerchantCode();
  ok(/^MRC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(code), 'a code looks like MRC-XXXX-XXXX with no I, L, O or U');
  ok(normaliseMerchantCode(code) === code, 'a generated code validates');
  ok(normaliseMerchantCode(code.toLowerCase().replace(/-/g, ' ')) === code, 'typed in lower case with spaces, it still resolves');
  ok(normaliseMerchantCode(code.replace('MRC-', '').replace('-', '')) === code, 'the MRC prefix is optional');
  const wrong = code.slice(0, -1) + (code.slice(-1) === '0' ? '1' : '0');
  ok(normaliseMerchantCode(wrong) === null, 'a mistyped last character fails the check');
  let caught = 0, tried = 0;
  for (let i = 0; i < 300; i++) {
    const c = generateMerchantCode(); const body = c.replace('MRC-', '').replace('-', '');
    if (body[2] === body[3]) continue;
    tried++; if (normaliseMerchantCode('MRC-' + body.slice(0, 2) + body[3] + body[2] + '-' + body.slice(4)) === null) caught++;
  }
  ok(caught / tried > 0.98, `swapping two neighbouring characters is caught ${(100 * caught / tried).toFixed(0)}% of the time (a one-character check)`);
  ok(normaliseMerchantCode('') === null && normaliseMerchantCode('MRC-123') === null, 'empty or short input is refused');
  ok(new Set(Array.from({ length: 200 }, () => generateMerchantCode())).size === 200, 'codes are not repeated');

  console.log('\n2. plans are data');
  ok((await api('get', '/admin/v1/plans', undefined, {})).status === 401, 'the plan list needs the operator token');
  ok((await api('get', '/admin/v1/plans')).body.plans.length === 0, 'no plan exists until an operator creates one');
  ok((await api('put', '/admin/v1/plans/Bad_ID', { name: 'x', features: [] })).status === 400, 'a plan id must be lower-case letters, digits and hyphens');
  ok((await api('put', '/admin/v1/plans/retail', { name: '', features: [] })).status === 400, 'a plan needs a name');
  ok((await api('put', '/admin/v1/plans/retail', { name: 'Retail', features: ['Not Valid'] })).status === 400, 'a feature key must be well formed');
  ok((await api('put', '/admin/v1/plans/retail', { name: 'Retail', features: [], device_limit: 0 })).status === 400, 'a device limit of zero is refused (leave it empty for unlimited)');
  const retail = await api('put', '/admin/v1/plans/retail-starter', { name: 'Retail Starter', features: ['core.pos', 'retail.catalog', 'retail.inventory', 'core.pos'], device_limit: 2, location_limit: 1, grace_days: 14, term_days: 365 });
  ok(retail.status === 200 && retail.body.plan.features.length === 3, 'a plan is saved (duplicate features collapsed)');
  await api('put', '/admin/v1/plans/pro', { name: 'Pro', features: ['core.pos', 'retail.catalog', 'retail.inventory', 'retail.purchasing', 'advanced.multi_location'], device_limit: 5, location_limit: 3, grace_days: 14, term_days: 365 });
  await api('put', '/admin/v1/plans/legacy', { name: 'Legacy', features: ['core.pos'], is_active: false });
  ok((await api('get', '/admin/v1/plans')).body.plans.length === 3, 'three plans are listed');
  ok(!!parsePlan('a-b', { name: 'N', features: [] }).plan && !parsePlan('a', { name: 'N', features: [] }).plan, 'plan parsing accepts a good id and refuses a one-character id');

  console.log('\n3. creating a merchant creates its organisation and licence');
  ok((await api('post', '/admin/v1/merchants', { name: 'Corner Shop', plan_id: 'retail-starter' }, {})).status === 401, 'creating a merchant needs the operator token');
  ok((await api('post', '/admin/v1/merchants', { plan_id: 'retail-starter' })).status === 400, 'a merchant needs a name');
  ok((await api('post', '/admin/v1/merchants', { name: 'X', plan_id: 'nope' })).status === 400, 'an unknown plan is refused');
  ok((await api('post', '/admin/v1/merchants', { name: 'X', plan_id: 'legacy' })).status === 400, 'a retired plan cannot be sold');
  ok((await api('post', '/admin/v1/merchants', { name: 'X', plan_id: 'retail-starter', contact_email: 'nope' })).status === 400, 'a bad contact email is refused');
  const made = await api('post', '/admin/v1/merchants', { name: 'Corner Shop', contact_email: 'owner@cornershop.test', plan_id: 'retail-starter', notes: 'pilot' });
  ok(made.status === 201 && normaliseMerchantCode(made.body.merchant.merchant_code) === made.body.merchant.merchant_code, 'the merchant gets a valid human-readable code');
  const M = made.body.merchant; const L = made.body.license;
  ok(M.organization_uid.startsWith('org_') && M.status === 'active' && M.plan_id === 'retail-starter', 'and an organisation id, active, on the plan');
  ok(L.status === 'active' && L.plan === 'retail-starter' && L.device_limit === 2 && L.location_limit === 1 && L.grace_days === 14, 'the licence copies the plan limits');
  ok(L.features.join() === 'core.pos,retail.catalog,retail.inventory' && !!L.expires_at, 'the plan features and a one-year expiry are on the licence');
  const days = (Date.parse(L.expires_at) - Date.parse(L.issued_at)) / 86_400_000;
  ok(Math.round(days) === 365, 'the term is 365 days');
  const trial = await api('post', '/admin/v1/merchants', { name: 'Café Trial', plan_id: 'pro', term_days: 30 });
  ok(Math.round((Date.parse(trial.body.license.expires_at) - Date.parse(trial.body.license.issued_at)) / 86_400_000) === 30, 'a term can be overridden per merchant (a 30-day trial)');

  console.log('\n4. finding merchants');
  const list = (await api('get', '/admin/v1/merchants')).body.merchants;
  ok(list.length === 2 && list.every((m: any) => m.license_status === 'active'), 'both merchants are listed with their licence status');
  ok((await api('get', '/admin/v1/merchants?q=corner')).body.merchants.length === 1, 'search by name');
  ok((await api('get', `/admin/v1/merchants?q=${M.merchant_code.slice(4, 8)}`)).body.merchants.length >= 1, 'search by part of the code');
  const got = await api('get', `/admin/v1/merchants/${M.merchant_code.toLowerCase().replace(/-/g, ' ')}`.replace(/ /g, '%20'));
  ok(got.status === 200 && got.body.merchant.name === 'Corner Shop' && got.body.health.organization_uid === M.organization_uid, 'a merchant is read by the code as a person would type it, with its health');
  ok((await api('get', '/admin/v1/merchants/MRC-0000-0000')).status === 400 || (await api('get', '/admin/v1/merchants/MRC-0000-0000')).status === 404, 'an unknown code is refused');
  ok((await api('get', `/admin/v1/merchants/${wrong}`)).status === 400, 'a code with a wrong check character is refused before any lookup');
  const edit = await api('put', `/admin/v1/merchants/${M.merchant_code}`, { name: 'Corner Shop Ltd', notes: 'renamed' });
  ok(edit.status === 200 && edit.body.merchant.name === 'Corner Shop Ltd', 'a merchant can be renamed');

  console.log('\n5. devices: the licence decides who can join');
  const tok = async (extra: any = {}) => (await api('post', `/admin/v1/merchants/${M.merchant_code}/activation-tokens`, extra));
  const t1 = await tok({ location_uid: 'loc-1', register_uid: 'reg-1' });
  ok(t1.status === 201 && t1.body.token.startsWith('plemmo_act_'), 'an activation token is issued for the merchant');
  const enroll = (token: string, uid: string) => request(app).post('/sync/v1/enroll').send({ token, device_uid: uid, public_key: 'KEY-' + uid });
  ok((await enroll(t1.body.token, 'dev-1')).status === 201, 'first terminal enrols');
  const t2 = await tok(); ok((await enroll(t2.body.token, 'dev-2')).status === 201, 'second terminal enrols (plan allows 2)');
  const t3 = await tok();
  const full = await enroll(t3.body.token, 'dev-3');
  ok(full.status === 403 && full.body.reason === 'device_limit_reached' && full.body.device_limit === 2, 'a third terminal is refused: the plan allows 2');
  ok((await store.peekEnrollmentToken(require('../cloud/enrollment').hashToken(t3.body.token), new Date().toISOString())) !== null, 'and the refused token was not burned');
  await store.revokeDevice('dev-2');
  ok((await enroll(t3.body.token, 'dev-3')).status === 201, 'replace a terminal: revoke the old one and the same token now works');

  console.log('\n6. suspend, reactivate, close');
  await store.revokeDevice('dev-1');
  const t5 = await tok(); // issued while active, redeemed while suspended
  const sus = await api('post', `/admin/v1/merchants/${M.merchant_code}/suspend`, { reason: 'unpaid invoice' });
  ok(sus.status === 200 && sus.body.merchant.status === 'suspended' && sus.body.license.status === 'suspended', 'suspending a merchant suspends its licence');
  ok((await api('post', `/admin/v1/merchants/${M.merchant_code}/suspend`)).status === 409, 'it cannot be suspended twice');
  const t4 = await tok();
  ok(t4.status === 409, 'a suspended merchant cannot be given an activation token');
  const blocked = await enroll(t5.body.token, 'dev-5');
  ok(blocked.status === 403 && blocked.body.reason === 'license_not_active', 'a token issued earlier cannot enrol a terminal while the merchant is suspended');
  const rea = await api('post', `/admin/v1/merchants/${M.merchant_code}/reactivate`);
  ok(rea.status === 200 && rea.body.merchant.status === 'active' && rea.body.license.status === 'active', 'reactivating restores the licence');
  ok((await enroll(t5.body.token, 'dev-5')).status === 201, 'and the same token then works: nothing was burned while suspended');
  ok((await api('post', `/admin/v1/merchants/${M.merchant_code}/reactivate`)).status === 409, 'an active merchant cannot be reactivated');
  const close = await api('post', `/admin/v1/merchants/${trial.body.merchant.merchant_code}/close`);
  ok(close.status === 200 && close.body.merchant.status === 'closed' && close.body.license.status === 'revoked', 'closing a merchant revokes its licence');
  ok((await api('post', `/admin/v1/merchants/${trial.body.merchant.merchant_code}/reactivate`)).status === 409, 'a closed merchant cannot be reactivated');
  ok((await api('post', `/admin/v1/merchants/${trial.body.merchant.merchant_code}/plan`, { plan_id: 'pro' })).status === 409, 'or change plan');
  ok((await api('post', `/admin/v1/merchants/${trial.body.merchant.merchant_code}/activation-tokens`)).status === 409, 'or enrol a device');

  console.log('\n7. change plan and renew');
  const before = (await store.getLicense(M.organization_uid));
  const up = await api('post', `/admin/v1/merchants/${M.merchant_code}/plan`, { plan_id: 'pro' });
  ok(up.status === 200 && up.body.license.plan === 'pro' && up.body.license.device_limit === 5 && up.body.license.features.includes('retail.purchasing'), 'upgrading re-derives the limits and features from the new plan');
  ok(up.body.license.expires_at === before.expires_at && up.body.license.status === 'active', 'the paid-up expiry and status carry over');
  ok((await api('post', `/admin/v1/merchants/${M.merchant_code}/plan`, { plan_id: 'legacy' })).status === 400, 'a retired plan cannot be switched to');
  const ren = await api('post', `/admin/v1/merchants/${M.merchant_code}/renew`, { term_days: 30 });
  ok(Date.parse(ren.body.license.expires_at) - Date.parse(before.expires_at) === 30 * 86_400_000, 'renewing early adds to the existing expiry (no paid time is lost)');
  const lapsed = { ...(await store.getLicense(M.organization_uid)), status: 'expired', expires_at: new Date(Date.now() - 5 * 86_400_000).toISOString() };
  await store.upsertLicense(lapsed, new Date().toISOString());
  const ren2 = await api('post', `/admin/v1/merchants/${M.merchant_code}/renew`, { term_days: 10 });
  const left = (Date.parse(ren2.body.license.expires_at) - Date.now()) / 86_400_000;
  ok(ren2.body.license.status === 'active' && left > 9.9 && left < 10.1, 'renewing a lapsed licence counts from today and makes it active again');
  ok((await api('post', `/admin/v1/merchants/${M.merchant_code}/renew`, { term_days: 0 })).status === 400, 'a renewal needs a positive whole number of days');

  console.log('\n8. every change is in the audit log');
  const log = await auditKinds();
  for (const k of ['plan_saved', 'merchant_created', 'merchant_updated', 'activation_token_issued', 'merchant_suspend', 'merchant_reactivate', 'merchant_close', 'merchant_plan_changed', 'merchant_renewed']) ok(log.includes(k), `audit: ${k}`);
  ok(!!licenceFromPlan({ plan_id: 'p', name: 'p', description: '', features: [], device_limit: null, location_limit: null, grace_days: 0, term_days: null, is_active: true }, 'o', new Date().toISOString()).organization_uid, 'licenceFromPlan builds a licence');

}

async function main() {
  process.env.PLEMMO_CLOUD_ADMIN_TOKEN = TOKEN;
  const sqlite = new SqliteCloudStore();
  await suite(sqlite, 'SQLite', async () => (sqlite as any).db.prepare("SELECT kind FROM cloud_sync_log WHERE kind LIKE 'merchant_%' OR kind LIKE 'plan_%' OR kind = 'activation_token_issued'").all().map((r: any) => r.kind));
  // The production store runs the same suite when a database is configured (CI's postgres-sync job sets it).
  const dsn = process.env.PLEMMO_CLOUD_DB_URL;
  if (dsn) {
    const { Pool } = require('pg');
    const { PostgresCloudStore } = require('../cloud/postgres-store');
    const { migrateToLatest } = require('../cloud/migrate');
    const schema = `commercial_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const admin = new Pool({ connectionString: dsn }); await admin.query(`CREATE SCHEMA "${schema}"`); await admin.end();
    const pool = new Pool({ connectionString: dsn, options: `-c search_path=${schema}`, max: 4 });
    try {
      await migrateToLatest(pool);
      await suite(new PostgresCloudStore(pool), 'PostgreSQL', async () => (await pool.query("SELECT kind FROM cloud_sync_log WHERE kind LIKE 'merchant_%' OR kind LIKE 'plan_%' OR kind = 'activation_token_issued'")).rows.map((r: any) => r.kind));
    } finally {
      await pool.end();
      const a2 = new Pool({ connectionString: dsn }); await a2.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await a2.end();
    }
  } else {
    console.log('\n  ⏭ PostgreSQL part not run (set PLEMMO_CLOUD_DB_URL to run it)');
  }
  console.log(`\n✅ Plemmo Cloud commercial layer passed (${checks} checks)`);
}
main().catch((err) => { console.error(err); process.exit(1); });
