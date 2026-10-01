/*
 * Brand configuration and install defaults.
 *
 * The product name and links come from brand/brand.json (env overrides it), https links only, an empty link
 * stays empty; GET /api/brand is public so the sign-in screen can use it; a fresh install defaults to the UK.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-brand-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getSettingValue } from '../main/db';
import { getBrand, resetBrandCache } from '../main/brand';
import { DEFAULT_COUNTRY, DEFAULT_CURRENCY, DEFAULT_TIMEZONE } from '../main/core/defaults';

let passed = 0;
function ok(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); passed++; console.log(`  ✓ ${msg}`); }

async function run() {
  console.log('Testing brand configuration and install defaults...');
  const keys = ['PLEMMO_BRAND_NAME', 'PLEMMO_BRAND_SHORT_NAME', 'PLEMMO_BRAND_WEBSITE_URL', 'PLEMMO_BRAND_SUPPORT_EMAIL', 'PLEMMO_BRAND_MARK', 'PLEMMO_BRAND_TERMS_URL'];
  for (const k of keys) delete process.env[k];
  resetBrandCache();

  console.log('\n1. defaults come from brand/brand.json');
  let b = getBrand();
  ok(b.productName === 'Meridian POS' && b.shortName === 'Meridian' && b.markLetter === 'M', 'product name, short name and mark');
  ok(b.websiteUrl === '' && b.termsUrl === '' && b.privacyUrl === '' && b.supportEmail === '', 'no link or address is invented: they are empty');
  ok(!JSON.stringify(b).includes('meridian.pos') && !/flopos|flocafe/i.test(JSON.stringify(b)), 'no domain and no upstream brand is built in');

  console.log('\n2. the environment overrides, with validation');
  process.env.PLEMMO_BRAND_NAME = 'Acme Till';
  process.env.PLEMMO_BRAND_SHORT_NAME = 'Acme';
  process.env.PLEMMO_BRAND_MARK = 'Ωmega';
  process.env.PLEMMO_BRAND_WEBSITE_URL = 'https://example.test/';
  process.env.PLEMMO_BRAND_TERMS_URL = 'javascript:alert(1)';
  process.env.PLEMMO_BRAND_SUPPORT_EMAIL = 'not an email';
  resetBrandCache(); b = getBrand();
  ok(b.productName === 'Acme Till' && b.shortName === 'Acme', 'name and short name are overridden');
  ok(b.markLetter === 'Ω', 'the mark is one character');
  ok(b.websiteUrl === 'https://example.test/', 'an https link is accepted');
  ok(b.termsUrl === '', 'a javascript: link is refused (the default, empty, stays)');
  ok(b.supportEmail === '', 'an invalid support address is refused');
  process.env.PLEMMO_BRAND_NAME = '   ';
  resetBrandCache();
  ok(getBrand().productName === 'Meridian POS', 'a blank name never replaces the product name');

  console.log('\n3. /api/brand is public and carries the brand');
  process.env.PLEMMO_BRAND_NAME = 'Acme Till'; resetBrandCache();
  initDatabase();
  await startServer();
  try {
    const base = `http://127.0.0.1:${getServerPort()}`;
    const res = await request(base).get('/api/brand');
    ok(res.status === 200 && res.body.brand.productName === 'Acme Till' && res.body.brand.websiteUrl === 'https://example.test/', 'no sign-in needed; it returns the configured brand');
    const health = await request(base).get('/api/health');
    ok(/Acme Till Local API/.test(health.body.service), 'the health check names the configured product');
    ok((await request(base).get('/api/products')).status === 401, 'other routes still need sign-in');

    console.log('\n4. a fresh install is a UK install');
    ok(DEFAULT_COUNTRY === 'GB' && DEFAULT_CURRENCY === 'GBP' && DEFAULT_TIMEZONE === 'Europe/London', 'the defaults module says GB, GBP, Europe/London');
    ok(getSettingValue('country') === 'GB' && getSettingValue('currency') === 'GBP' && getSettingValue('currency_symbol') === '£' && getSettingValue('timezone') === 'Europe/London', 'the seeded settings are United Kingdom, pounds, London time');
  } finally {
    stopServer();
    closeDatabase();
    for (const k of keys) delete process.env[k];
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\n✅ Brand and defaults passed (${passed} checks)`);
}
run().catch((err) => { console.error(err); process.exit(1); });
