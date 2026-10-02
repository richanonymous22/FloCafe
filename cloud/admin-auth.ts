/**
 * Plemmo Cloud — operator (admin) API authentication.
 *
 * The `/admin/v1/*` endpoints are the backend contract the SEPARATE FloAdmin
 * operator console calls to provision businesses, issue/manage licenses and
 * activation tokens, and read operational health. There is no admin UI in this
 * repository — only this API.
 *
 * Auth is a single shared operator bearer token supplied via the
 * `PLEMMO_CLOUD_ADMIN_TOKEN` env var (a secret managed by the deployment, never
 * committed). When it is unset the admin API is CLOSED (every route answers 503)
 * — it is never open by default. This is deliberately a coarse gate for V1: it
 * gates machine-to-machine access from FloAdmin, which does its own per-operator
 * authn/authz. Per-operator identity/audit can layer on later without changing
 * the route contract.
 */
import { timingSafeEqual } from 'crypto';

/** The configured operator token, or null when the admin API is disabled. */
export function getCloudAdminToken(): string | null {
  const token = (process.env.PLEMMO_CLOUD_ADMIN_TOKEN || '').trim();
  return token ? token : null;
}

/** True when the admin API is configured (a token is set). */
export function isAdminApiEnabled(): boolean {
  return getCloudAdminToken() !== null;
}

/**
 * Extracts the bearer token from an Authorization header value.
 *
 * Parsed with plain string ops rather than a regex: a pattern like
 * `^Bearer\s+(.+)$` has overlapping `\s+`/`.+` quantifiers over attacker-
 * controlled input and can backtrack polynomially (ReDoS). String slicing is
 * linear and cannot.
 */
export function bearerToken(authorizationHeader: string | undefined | null): string | null {
  if (!authorizationHeader) return null;
  const header = authorizationHeader.trim();
  const prefix = 'bearer ';
  if (header.length <= prefix.length) return null;
  if (header.slice(0, prefix.length).toLowerCase() !== prefix) return null;
  const token = header.slice(prefix.length).trim();
  return token ? token : null;
}

/**
 * Constant-time comparison of a presented token against the configured one.
 * Returns false when the admin API is disabled or the token is missing/wrong.
 */
export function operatorTokenMatches(provided: string | null | undefined): boolean {
  const expected = getCloudAdminToken();
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
