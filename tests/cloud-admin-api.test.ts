/*
 * Plemmo Cloud — operator (admin) API (Gate 3A/3B/3C backend contract).
 *
 * The /admin/v1/* routes are the backend contract the SEPARATE FloAdmin console
 * calls; there is no admin UI in this repo. This suite drives them over real
 * HTTP (supertest) against the in-memory SqliteCloudStore and proves:
 *   - the surface is CLOSED when no operator token is configured (503)
 *   - it rejects a missing/wrong bearer token (401)
 *   - license issuance + read + lifecycle transitions (suspend / reactivate)
 *   - activation-token issuance drives the real device enrollment chain
 *     (org binds from the token, single-use), and
 *   - operational health reflects the enrolled device.
 *
 * It never touches FloPOS anything and needs no Postgres.
 */
import * as assert from 'node:assert/strict';

const request = require('supertest');
const { SqliteCloudStore } = require('../cloud/store');
const { createCloudServer } = require('../cloud/server');

const TOKEN = 'test-operator-token-abc123';
const auth = (t: string = TOKEN) => ({ Authorization: `Bearer ${t}` });

async function run() {
  console.log('Testing Plemmo Cloud operator (admin) API...');
  const store = new SqliteCloudStore(); // :memory:
  const app = createCloudServer(store);

  const priorToken = process.env.PLEMMO_CLOUD_ADMIN_TOKEN;
  try {
    // ── disabled by default (no token configured) ─────────────────────────────
    delete process.env.PLEMMO_CLOUD_ADMIN_TOKEN;
    let res = await request(app).post('/admin/v1/licenses').send({ organization_uid: 'org-1' });
    assert.equal(res.status, 503, 'admin API is closed (503) when no operator token is configured');
    assert.equal(res.body.error, 'admin_api_disabled', 'closed surface reports admin_api_disabled');

    // ── enable the admin API ──────────────────────────────────────────────────
    process.env.PLEMMO_CLOUD_ADMIN_TOKEN = TOKEN;

    res = await request(app).post('/admin/v1/licenses').send({ organization_uid: 'org-1' });
    assert.equal(res.status, 401, 'missing bearer token is rejected');
    res = await request(app).post('/admin/v1/licenses').set(auth('wrong')).send({ organization_uid: 'org-1' });
    assert.equal(res.status, 401, 'wrong bearer token is rejected');

    // ── license issuance ──────────────────────────────────────────────────────
    res = await request(app).post('/admin/v1/licenses').set(auth()).send({});
    assert.equal(res.status, 400, 'organization_uid is required to issue a license');

    res = await request(app).post('/admin/v1/licenses').set(auth()).send({ organization_uid: 'org-1', status: 'bogus' });
    assert.equal(res.status, 400, 'an invalid status is rejected');

    res = await request(app).post('/admin/v1/licenses').set(auth()).send({
      organization_uid: 'org-1', plan: 'standard', expires_at: '2027-01-01T00:00:00Z',
      grace_days: 7, device_limit: 3, location_limit: 2, features: ['reports', 'kds'],
    });
    assert.equal(res.status, 200, 'a valid license issues');
    assert.equal(res.body.license.status, 'active', 'issued license defaults to active');
    assert.ok(res.body.license.issued_at, 'issued_at is stamped');
    assert.ok(res.body.license.activated_at, 'activated_at is stamped for an active license');
    assert.equal(res.body.license.device_limit, 3, 'device_limit is persisted');
    assert.deepEqual(res.body.license.features, ['reports', 'kds'], 'features are persisted');

    // persisted + readable
    const stored = store.getLicense('org-1');
    assert.equal(stored.plan, 'standard', 'license is persisted in the store');
    res = await request(app).get('/admin/v1/licenses/org-1').set(auth());
    assert.equal(res.status, 200, 'the license is readable');
    assert.equal(res.body.license.plan, 'standard', 'read license matches');
    res = await request(app).get('/admin/v1/licenses/nope').set(auth());
    assert.equal(res.status, 404, 'reading an unknown org is 404');

    // ── lifecycle transitions ─────────────────────────────────────────────────
    res = await request(app).post('/admin/v1/licenses/org-1/status').set(auth()).send({ status: 'suspended' });
    assert.equal(res.status, 200, 'suspend transition succeeds');
    assert.equal(store.getLicense('org-1').status, 'suspended', 'suspension is persisted');
    res = await request(app).post('/admin/v1/licenses/org-1/status').set(auth()).send({ status: 'active' });
    assert.equal(res.status, 200, 'reactivation succeeds');
    assert.equal(store.getLicense('org-1').status, 'active', 'reactivation is persisted');
    res = await request(app).post('/admin/v1/licenses/nope/status').set(auth()).send({ status: 'revoked' });
    assert.equal(res.status, 404, 'status change on an unknown org is 404');
    res = await request(app).post('/admin/v1/licenses/org-1/status').set(auth()).send({ status: 'bogus' });
    assert.equal(res.status, 400, 'an invalid status transition is rejected');

    // ── activation token → real device enrollment chain ───────────────────────
    res = await request(app).post('/admin/v1/enrollment-tokens').set(auth())
      .send({ organization_uid: 'org-1', location_uid: 'loc-1', register_uid: 'reg-1' });
    assert.equal(res.status, 201, 'an activation token issues');
    const token: string = res.body.token;
    assert.ok(token && token.startsWith('plemmo_act_'), 'the plaintext token is returned once');

    // A device redeems it — org/location bind FROM the token, not the caller.
    let enroll = await request(app).post('/sync/v1/enroll')
      .send({ token, device_uid: 'dev-1', public_key: 'BASE64_PUBLIC_KEY_PLACEHOLDER' });
    assert.equal(enroll.status, 201, 'the device enrolls with the activation token');
    assert.equal(enroll.body.organization_uid, 'org-1', 'the device org is bound from the token');
    assert.equal(store.getDevice('dev-1').organization_uid, 'org-1', 'the device is registered under the token org');

    // Single-use: the same token cannot be redeemed twice.
    enroll = await request(app).post('/sync/v1/enroll')
      .send({ token, device_uid: 'dev-2', public_key: 'ANOTHER_KEY' });
    assert.equal(enroll.status, 400, 'the activation token is single-use');

    // ── operational health read model ─────────────────────────────────────────
    res = await request(app).get('/admin/v1/organizations/org-1/health').set(auth());
    assert.equal(res.status, 200, 'org health is readable');
    assert.equal(res.body.organization_uid, 'org-1', 'health is scoped to the org');
    assert.ok(res.body.devices >= 1, 'health reflects the enrolled device');

    // enrollment tokens still require the operator token + org
    res = await request(app).post('/admin/v1/enrollment-tokens').send({ organization_uid: 'org-1' });
    assert.equal(res.status, 401, 'token issuance requires operator auth');
    res = await request(app).post('/admin/v1/enrollment-tokens').set(auth()).send({});
    assert.equal(res.status, 400, 'token issuance requires organization_uid');

    console.log('✅ Plemmo Cloud operator (admin) API tests passed');
  } finally {
    if (priorToken === undefined) delete process.env.PLEMMO_CLOUD_ADMIN_TOKEN;
    else process.env.PLEMMO_CLOUD_ADMIN_TOKEN = priorToken;
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
