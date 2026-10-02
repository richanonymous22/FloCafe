/**
 * Plemmo Cloud — the commercial layer: plans, merchants and the licences issued from them.
 *
 *   plan      a row of data an operator edits (no code change to add or change a plan): its feature
 *             entitlements, device and location limits, grace period and default term.
 *   merchant  a customer, with a human-readable code (MRC-XXXX-XXXX) that staff read out on the phone, and
 *             the organisation_uid the sync engine knows it by. Suspending a merchant suspends its licence.
 *   licence   always derived from a plan (`licenceFromPlan`) so a plan change is one operation.
 *
 * Merchant codes use Crockford base32 (no I, L, O, U) plus two check characters, so a mistyped code is rejected
 * before it is looked up.
 */
import { randomBytes } from 'crypto';
import type { CloudLicense } from './store';

export interface CloudPlan {
  plan_id: string;
  name: string;
  description: string;
  features: string[];
  device_limit: number | null;
  location_limit: number | null;
  grace_days: number;
  term_days: number | null;
  is_active: boolean;
}

export type MerchantStatus = 'active' | 'suspended' | 'closed';

export interface CloudMerchant {
  merchant_code: string;
  name: string;
  contact_email: string | null;
  organization_uid: string;
  plan_id: string | null;
  status: MerchantStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

function checkChars(body: string): string {
  let acc = 0;
  for (const ch of body) acc = (acc * 37 + ALPHABET.indexOf(ch) + 1) % 1021;
  return ALPHABET[acc >> 5] + ALPHABET[acc & 31];
}

/** `MRC-ABCD-EFGH`: six random characters and two check characters (a slip or a swap is caught ~999 times in 1000). */
export function generateMerchantCode(bytes: Buffer = randomBytes(6)): string {
  let body = '';
  for (let i = 0; i < 6; i++) body += ALPHABET[bytes[i] % 32];
  const full = body + checkChars(body);
  return `MRC-${full.slice(0, 4)}-${full.slice(4)}`;
}

/** Normalises what a person typed (case, spaces, O→0, I/L→1) and checks the check characters. */
export function normaliseMerchantCode(input: string): string | null {
  const raw = String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^MRC/, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (raw.length !== 8 || [...raw].some((c) => !ALPHABET.includes(c))) return null;
  if (checkChars(raw.slice(0, 6)) !== raw.slice(6)) return null;
  return `MRC-${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function organizationUidFor(): string {
  return `org_${randomBytes(12).toString('base64url')}`;
}

const PLAN_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const FEATURE = /^[a-z][a-z0-9_.]{1,59}$/;

/** Validates an operator-supplied plan; returns the clean plan or the first problem. */
export function parsePlan(id: string, body: Record<string, unknown>): { plan?: CloudPlan; error?: string } {
  if (!PLAN_ID.test(id)) return { error: 'plan id must be 2–40 characters: lowercase letters, digits and hyphens' };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 80) return { error: 'name is required (80 characters at most)' };
  if (!Array.isArray(body.features)) return { error: 'features must be a list of feature keys' };
  const features = [...new Set(body.features.map(String))];
  if (features.some((f) => !FEATURE.test(f))) return { error: 'a feature key is not valid (lowercase, digits, . and _)' };
  const limit = (v: unknown, label: string): number | null | string => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 100000 ? n : `${label} must be a whole number of at least 1, or empty for unlimited`;
  };
  const dev = limit(body.device_limit, 'device_limit'); if (typeof dev === 'string') return { error: dev };
  const loc = limit(body.location_limit, 'location_limit'); if (typeof loc === 'string') return { error: loc };
  const term = limit(body.term_days, 'term_days'); if (typeof term === 'string') return { error: term };
  const grace = body.grace_days == null ? 7 : Number(body.grace_days);
  if (!Number.isInteger(grace) || grace < 0 || grace > 90) return { error: 'grace_days must be between 0 and 90' };
  return { plan: { plan_id: id, name, description: typeof body.description === 'string' ? body.description.slice(0, 300) : '', features, device_limit: dev, location_limit: loc, grace_days: grace, term_days: term, is_active: body.is_active !== false } };
}

/** The licence a plan grants, as at `nowIso`. `termDays` overrides the plan's default term. */
export function licenceFromPlan(plan: CloudPlan, organizationUid: string, nowIso: string, opts: { termDays?: number | null; status?: CloudLicense['status']; activatedAt?: string | null } = {}): CloudLicense {
  const term = opts.termDays === undefined ? plan.term_days : opts.termDays;
  const status = opts.status ?? 'active';
  return {
    organization_uid: organizationUid,
    status,
    plan: plan.plan_id,
    issued_at: nowIso,
    activated_at: opts.activatedAt !== undefined ? opts.activatedAt : (status === 'active' ? nowIso : null),
    expires_at: term ? new Date(Date.parse(nowIso) + term * 86_400_000).toISOString() : null,
    grace_days: plan.grace_days,
    device_limit: plan.device_limit,
    location_limit: plan.location_limit,
    features: [...plan.features],
    signature: null,
  };
}

/**
 * What the operator hands the merchant: the activation token, with the cloud address folded in when the
 * deployment knows its public URL (`PLEMMO_CLOUD_PUBLIC_URL`), so the terminal needs only this one string.
 * Format `<base64url(url)>~<token>`; a bare token still works on a build that knows its cloud address.
 * (`main/core/activation.ts` parses it; the two are kept in step by tests.)
 */
export function makeActivationCode(cloudUrl: string | undefined, token: string): string {
  const url = (cloudUrl || '').trim().replace(/\/+$/, '');
  return url ? `${Buffer.from(url, 'utf8').toString('base64url')}~${token}` : token;
}

/** A plausible e-mail address, checked in linear time (no backtracking regular expression). */
export function isPlausibleEmail(s: string): boolean {
  if (s.length > 254 || /\s/.test(s)) return false;
  const at = s.indexOf('@');
  if (at < 1 || at !== s.lastIndexOf('@')) return false;
  const domain = s.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}
