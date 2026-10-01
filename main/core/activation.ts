/**
 * Device activation — how a terminal joins its merchant's cloud account.
 *
 * The operator gives the merchant an ACTIVATION CODE (`<cloud address>~<one-time token>`, or a bare token on
 * a build that knows its cloud). `activateDevice`:
 *   1. works out the cloud address (from the code, else the build's policy, else the environment) and checks
 *      it is https (plain http only for this machine / a .local host),
 *   2. makes this device's signing keypair (the private key never leaves the device),
 *   3. redeems the token at `/sync/v1/enroll`; the cloud binds the organisation from the TOKEN,
 *   4. fetches and verifies the signed licence and caches it,
 *   5. starts cloud sync.
 * A refusal (suspended merchant, device limit, a used token) leaves the device exactly as it was.
 */
import { getDatabase, getSettingValue, now, withTxn } from '../db';
import { getOrganizationContext, resetContextCache } from './context';
import { recordAuditEvent } from './audit';
import { getLicensePolicy } from './license-policy';
import { getOrCreateDeviceKey } from './sync/device-identity';
import { HttpSyncTransport } from './sync/http-transport';
import { SyncTransportError } from './sync/types';
import { createCloudLicenseVerifier, effectiveStatus, getLicense, refreshLicense, LicenseSignatureError, hasStoredLicense, touchLicenseClock } from './licensing';
import { restartSyncService } from '../services/sync-service';

export class ActivationError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 400) { super(message); this.name = 'ActivationError'; }
}

export function parseActivationCode(input: string): { cloudUrl: string | null; token: string } {
  const code = String(input || '').trim();
  const i = code.lastIndexOf('~');
  if (i < 0) return { cloudUrl: null, token: code };
  let cloudUrl: string | null = null;
  try { cloudUrl = Buffer.from(code.slice(0, i), 'base64url').toString('utf8').trim().replace(/\/+$/, '') || null; } catch { cloudUrl = null; }
  return { cloudUrl, token: code.slice(i + 1) };
}

function setSetting(key: string, value: string | null): void {
  const db = getDatabase();
  if (value === null) { db.prepare('DELETE FROM settings WHERE key = ?').run(key); return; }
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, now());
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** The cloud origins this build may connect to: the policy's cloud, the environment's, and any listed explicitly. */
export function allowedCloudOrigins(): string[] {
  const list = [getLicensePolicy().cloudUrl, process.env.PLEMMO_SYNC_URL || '', ...(process.env.PLEMMO_CLOUD_ALLOWED_ORIGINS || '').split(',')];
  const out: string[] = [];
  for (const raw of list.map((x) => x.trim()).filter(Boolean)) { try { out.push(new URL(raw).origin); } catch { /* ignore an unusable entry */ } }
  return out;
}

/**
 * Checks the cloud address from an activation code and returns the origin to connect to. The address is
 * never used as given: it must be https (plain http only for this machine), carry no credentials, and be
 * one the build allows — the pinned cloud of a release build, a configured origin, or (development builds
 * that pin nothing) this machine. The returned string is taken from the trusted list, so a code can never
 * point the till at an arbitrary host (it cannot be used to make the till probe a network).
 */
export function checkCloudUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { throw new ActivationError('The cloud address in this code is not valid.', 'bad_cloud_url'); }
  const loopback = LOOPBACK_HOSTS.find((h) => h === u.hostname || (u.hostname === '::1' && h === '[::1]'));
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new ActivationError('The cloud address must use https.', 'insecure_cloud_url');
  if (u.username || u.password) throw new ActivationError('The cloud address must not contain a user name or password.', 'bad_cloud_url');
  const allowed = allowedCloudOrigins();
  const hit = allowed.find((a) => a === u.origin);
  if (hit) return hit;
  if (allowed.length === 0 && loopback) {
    const port = Number(u.port);
    const scheme = u.protocol === 'https:' ? 'https' : 'http';
    return `${scheme}://${loopback}${Number.isInteger(port) && port > 0 ? ':' + port : ''}`;
  }
  throw new ActivationError('This activation code points at a cloud this build is not set up to use. Ask for a new code.', 'cloud_not_allowed');
}

// Every table whose rows carry the organisation id (found by schema inspection; a test keeps this list honest).
export const ORGANIZATION_COLUMN_TABLES = [
  'orders', 'locations', 'audit_events', 'payments', 'suppliers', 'purchase_orders', 'stock_transfers', 'inventory_movements',
  'organization_features', 'sync_outbox', 'remote_payment_events', 'remote_orders', 'remote_order_items', 'remote_bills',
  'sales_conflicts', 'sales_reconciliation_actions', 'sales_pending_relationships', 'remote_reference_entities', 'card_attempts',
];

/**
 * Make this install's organisation the merchant's cloud organisation. A till is created with its own local
 * organisation id; the cloud knows the merchant by the id it issued, and refuses events from a device whose
 * events name any other organisation. Everything already recorded moves over in one transaction (nothing is
 * deleted), and events the cloud refused for exactly this reason are queued to go again.
 */
export function adoptOrganization(newOrganizationId: string): void {
  const db = getDatabase();
  const current = getOrganizationContext()?.id;
  if (!current || current === newOrganizationId) return;
  withTxn(() => {
    db.pragma('defer_foreign_keys = ON');
    db.prepare('UPDATE organizations SET id = ? WHERE id = ?').run(newOrganizationId, current);
    for (const t of ORGANIZATION_COLUMN_TABLES) db.prepare(`UPDATE ${t} SET organization_id = ? WHERE organization_id = ?`).run(newOrganizationId, current);
    db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'plemmo_organization_id'").run(newOrganizationId, now());
    db.prepare("UPDATE sync_outbox SET status = 'pending', last_error = NULL WHERE status = 'failed' AND last_error = 'organization mismatch'").run();
  });
  resetContextCache();
}

export function isActivated(): boolean {
  return !!getSettingValue('cloud_activated_at') && !!getSettingValue('cloud_sync_url');
}

export interface ActivationResult { organization_uid: string; device_id: string; cloud_host: string; license_status: string; plan: string }

export async function activateDevice(input: { code: string; actorUserId?: string | null; fetchImpl?: typeof fetch }): Promise<ActivationResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const { cloudUrl: fromCode, token } = parseActivationCode(input.code);
  if (!token || !/^plemmo_act_[A-Za-z0-9_-]{16,}$/.test(token)) throw new ActivationError('That does not look like an activation code. Check it and try again.', 'bad_code');
  if (isActivated()) throw new ActivationError('This device is already activated.', 'already_activated', 409);
  const rawUrl = fromCode || getLicensePolicy().cloudUrl || (process.env.PLEMMO_SYNC_URL || '').trim();
  if (!rawUrl) throw new ActivationError('This code does not say where to connect and this build has no default. Ask for a new code.', 'no_cloud_url');
  const cloudUrl = checkCloudUrl(rawUrl);

  const previousUrl = getSettingValue('cloud_sync_url');
  setSetting('cloud_sync_url', cloudUrl); // the device key's storage and the sync guards depend on the cloud address
  let enrolled: { organization_uid?: string } = {};
  try {
    const key = getOrCreateDeviceKey();
    let res: Response;
    try {
      res = await fetchImpl(`${cloudUrl}/sync/v1/enroll`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, device_uid: key.deviceId, public_key: key.publicKeyPem }),
      });
    } catch {
      throw new ActivationError('Could not reach the cloud. Check this computer\'s internet connection and try again.', 'cloud_unreachable', 502);
    }
    const body = await res.json().catch(() => ({})) as { reason?: string; device_limit?: number; organization_uid?: string };
    if (res.status === 403 && body.reason === 'license_not_active') throw new ActivationError('This account\'s licence is not active. Contact support.', 'license_not_active', 403);
    if (res.status === 403 && body.reason === 'device_limit_reached') throw new ActivationError(`This plan allows ${body.device_limit ?? 'a limited number of'} devices and they are all in use. Remove one, or upgrade the plan.`, 'device_limit_reached', 403);
    if (res.status !== 201) {
      const msg = body.reason === 'device_exists' ? 'This device is already registered with the cloud. Ask support to reset it.' : 'This activation code is invalid, has expired or has already been used.';
      throw new ActivationError(msg, body.reason === 'device_exists' ? 'device_exists' : 'invalid_token');
    }
    enrolled = body;
  } catch (e) {
    setSetting('cloud_sync_url', previousUrl);
    throw e;
  }

  const org = enrolled.organization_uid as string;
  adoptOrganization(org);
  setSetting('cloud_organization_uid', org);
  setSetting('cloud_activated_at', now());
  const deviceId = getOrCreateDeviceKey().deviceId;
  recordAuditEvent({
    type: 'device.activated', actor: { userId: input.actorUserId ?? null }, entity: { type: 'device', id: deviceId },
    summary: `Device activated against ${new URL(cloudUrl).host}`, metadata: { organization_uid: org, cloud_host: new URL(cloudUrl).host },
  });

  // Licence: fetched and verified now so the till is usable the moment activation returns.
  const refreshed = await refreshNow(fetchImpl);
  restartSyncService();
  return { organization_uid: org, device_id: deviceId, cloud_host: new URL(cloudUrl).host, license_status: effectiveStatus(refreshed.license), plan: refreshed.license.plan };
}

/** Fetch the signed licence from the cloud and cache it. A refused or unreachable fetch keeps the cached one. */
export async function refreshNow(fetchImpl?: typeof fetch): Promise<{ license: ReturnType<typeof getLicense>; fetched: boolean; error?: string }> {
  const url = getSettingValue('cloud_sync_url');
  const org = getSettingValue('cloud_organization_uid');
  if (!url || !org) return { license: getLicense(), fetched: false, error: 'not_activated' };
  const transport = new HttpSyncTransport({ baseUrl: url, fetchImpl });
  let error: string | undefined;
  const verifier = createCloudLicenseVerifier(() => transport.pullLicense());
  let fetched = false;
  try {
    const fresh = await verifier.verify(org);
    const before = hasStoredLicense();
    setSetting('cloud_device_revoked', null); // the cloud answered and still knows this device
    const license = await refreshLicense({ verify: async () => fresh }, org);
    fetched = true;
    touchLicenseClock();
    recordAuditEvent({ type: 'license.refreshed', actor: { userId: null }, entity: { type: 'license', id: org }, summary: `Licence refreshed: ${license.status}${before ? '' : ' (first)'}`, metadata: { status: license.status, plan: license.plan } });
    return { license, fetched };
  } catch (e) {
    if (e instanceof LicenseSignatureError) error = 'license_signature_invalid';
    else if (e instanceof SyncTransportError && e.category === 'auth') {
      // The cloud refused this device's signature: it was removed from the account. Remember it, so the
      // gate stops trading as soon as the device is next online (until then the cached licence keeps working).
      setSetting('cloud_device_revoked', now());
      error = 'device_revoked';
    } else error = 'cloud_unreachable';
  }
  return { license: getLicense(), fetched, error };
}
