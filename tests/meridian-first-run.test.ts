/*
 * Meridian first-run onboarding — real browser-env verification (jsdom).
 *
 * Release-blocking regression: on a FRESH install (no users in the Plemmo
 * database) the Meridian UI, served in Plemmo mode, must render a first-run
 * setup form so the very first owner account can be created. Before this fix
 * the boot gate only ever rendered the email/password login, so a clean
 * install had no way to create the first owner and the POS was unusable.
 *
 * This boots the ACTUAL built bundle in a DOM against a running Plemmo server
 * with an empty users table, drives the real setup form (fills it, submits),
 * and asserts: the owner is created in the authoritative database, a real JWT
 * session is established, the gate is dismissed, and the app boots into the
 * main view on Plemmo data — signed in as the owner just created.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-firstrun-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    // No safeStorage → isMasterPinAvailable() is false, so setup does not
    // require a Master PIN in this environment (mirrors meridian-ui-boot).
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 5000, label = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return; } catch { /* keep polling */ } await sleep(50); }
  throw new Error(`Timed out waiting for ${label}`);
}

async function run() {
  console.log('Testing Meridian first-run onboarding (jsdom)...');

  initDatabase();
  const db = getDatabase();
  // Fresh install: no users. This is the exact state the bug report describes.
  assert((db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as any).n === 0, 'starts with zero users (fresh install)');

  await startServer();
  const port = getServerPort();
  const origin = `http://127.0.0.1:${port}`;
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend-meridian', 'dist', 'meridian-pos.html'), 'utf8');

  let dom: JSDOM | null = null;
  try {
    dom = new JSDOM(html, {
      url: origin + '/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window: any) {
        window.fetch = (input: any, init?: any) => fetch(input, init);
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      },
    });
    const win: any = dom.window;

    // 1. On a fresh install the boot gate renders the first-run SETUP form,
    //    not the login form. This is the regression that was missing.
    await waitFor(() => { const g = win.document.getElementById('plemmo-auth'); return !!g && !g.hidden && !!win.document.getElementById('plSetupForm'); }, 8000, 'first-run setup form');
    assert(!win.document.getElementById('plForm'), 'the login form is NOT shown on a fresh install');
    assert(!!win.document.getElementById('plName'), 'setup form has an owner-name field');
    assert(!!win.document.getElementById('plBiz'), 'setup form has a business-name field');
    assert(!!win.document.getElementById('plSetupEmail'), 'setup form has an email field');
    assert(!!win.document.getElementById('plSetupPass'), 'setup form has a password field');
    assert(!!win.document.getElementById('plTerms'), 'setup form has a terms checkbox');
    // No Master PIN field here — safeStorage is unavailable in this env.
    assert(!win.document.getElementById('plPin'), 'no Master PIN field when the keyring is unavailable');
    assert(!win.PlemmoAPI.isAuthenticated(), 'not authenticated before setup');

    // 1b. The client can read the authoritative setup status.
    const status = await win.PlemmoAPI.setupStatus();
    assert(status && status.needsSetup === true && status.userCount === 0, 'setupStatus() reports needsSetup on a fresh install');

    // 2. Fill and submit the real setup form.
    win.document.getElementById('plName').value = 'Ada Owner';
    win.document.getElementById('plBiz').value = 'First Run Cafe';
    win.document.getElementById('plSetupEmail').value = 'ada@firstrun.local';
    win.document.getElementById('plSetupPass').value = 'OwnerPass123';
    win.document.getElementById('plTerms').checked = true;
    win.document.getElementById('plSetupForm').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));

    // 3. The owner is created authoritatively and a real JWT session is set.
    await waitFor(() => win.PlemmoAPI.isAuthenticated(), 8000, 'authentication after setup');
    await waitFor(() => { const g = win.document.getElementById('plemmo-auth'); return !!g && g.hidden; }, 5000, 'gate dismissed');
    assert(!!win.PlemmoAPI.getToken(), 'a JWT token is stored after setup');

    const ownerRow = db.prepare(`SELECT id, name, email, role FROM users`).get() as any;
    assert(!!ownerRow, 'exactly one user now exists in the database');
    assert(ownerRow.email === 'ada@firstrun.local' && ownerRow.role === 'owner', 'the created user is the owner from the form');
    assert((db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as any).n === 1, 'setup created exactly one user');

    const user = win.PlemmoAPI.currentUser();
    assert(user && user.email === 'ada@firstrun.local', 'session user is the newly created owner');

    // 3b. Setup is now closed — status flips to not-needed.
    const after = await win.PlemmoAPI.setupStatus();
    assert(after && after.needsSetup === false && after.userCount === 1, 'setup is disabled once the owner exists');

    // 4. Session context loads and the app boots into the main view (no local
    //    onboarding), signed in as the real owner on the new business.
    await waitFor(() => !!(win.PlemmoSession && win.PlemmoSession.ctx && win.PlemmoSession.ctx.business), 5000, 'session context');
    assert(win.PlemmoSession.ctx.business.name === 'First Run Cafe', 'business context is the one just created');
    await waitFor(() => { const a = win.document.getElementById('app'); return !!a && !a.hidden; }, 8000, 'app view');
    assert(win.document.getElementById('onboard').hidden, 'Meridian local onboarding stays hidden in Plemmo mode');
    await waitFor(() => !!(win.__meridian && win.__meridian.S), 5000, 'state built');
    await waitFor(() => win.__meridian.U.user === ownerRow.id, 5000, 'signed in as the created owner');
    assert(win.__meridian.S.settings.name === 'First Run Cafe', 'running state reflects the new business');

    // 5. Persisted settings prove the profile seed ran (service model default).
    const svc = db.prepare(`SELECT value FROM settings WHERE key='service_model'`).get() as any;
    assert(svc && (svc.value === 'qsr' || svc.value === 'finedine'), `service_model persisted (got ${svc && svc.value})`);
    const onboarded = db.prepare(`SELECT value FROM settings WHERE key='onboarding_completed'`).get() as any;
    assert(onboarded && onboarded.value === 'true', 'onboarding marked complete authoritatively');

    console.log('✅ Meridian first-run onboarding (jsdom) tests passed');
  } finally {
    if (dom) dom.window.close();
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
