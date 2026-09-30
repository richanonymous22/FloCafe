/**
 * Plemmo Core — manager approval (PIN override) resolution.
 *
 * Several till actions (refund, void, price override) are permitted for an
 * owner/manager outright and for a cashier only when a manager/owner enters
 * their PIN at the till. The inherited routes each re-implemented the PIN loop
 * inline; the newer till routes share this one helper instead.
 *
 * The decision is made HERE, on the server, from the authenticated user's role
 * and (when needed) a PIN checked against `users.pin_hash`. The client can
 * neither grant itself the permission nor pick the approver's identity: the
 * returned approver is whoever the PIN actually belongs to.
 *
 * Failed PINs are rate limited per (client, action) exactly like the existing
 * PIN paths: 5 attempts per 15 minutes.
 */
import { getDatabase, verifyPin } from '../db';
import { hasPermission, Permission } from './authorization';

export class ApprovalError extends Error {
  readonly statusCode: number;
  readonly requiresApproval: boolean;
  constructor(message: string, statusCode: number, requiresApproval = false) {
    super(message);
    this.name = 'ApprovalError';
    this.statusCode = statusCode;
    this.requiresApproval = requiresApproval;
  }
}

export interface Approver {
  userId: string;
  role: string;
  /** 'self' = the caller already holds the permission; 'pin' = a manager PIN was supplied. */
  via: 'self' | 'pin';
}

const PIN_MAX_ATTEMPTS = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; resetAt: number }>();

function allowAttempt(key: string): boolean {
  const nowMs = Date.now();
  if (attempts.size > 500) {
    for (const [k, v] of attempts.entries()) if (nowMs > v.resetAt) attempts.delete(k);
  }
  const entry = attempts.get(key);
  if (!entry || nowMs > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: nowMs + PIN_WINDOW_MS });
    return true;
  }
  if (entry.count >= PIN_MAX_ATTEMPTS) return false;
  entry.count++;
  return true;
}

/** Test hook: forget all recorded PIN attempts. */
export function resetApprovalRateLimits(): void {
  attempts.clear();
}

export interface ResolveApproverInput {
  user: { userId: string; role: string };
  permission: Permission;
  overridePin?: unknown;
  /** Stable key for PIN rate limiting, e.g. `${ip}:refund`. */
  rateKey: string;
  /** What the approval is for, used in the "PIN required" message. */
  action: string;
}

export function resolveApprover(input: ResolveApproverInput): Approver {
  if (hasPermission(input.user.role, input.permission)) {
    return { userId: input.user.userId, role: input.user.role, via: 'self' };
  }
  const pin = input.overridePin === undefined || input.overridePin === null ? '' : String(input.overridePin).trim();
  if (!pin) {
    throw new ApprovalError(`Manager PIN required to ${input.action}`, 403, true);
  }
  if (!allowAttempt(`pin:${input.rateKey}`)) {
    throw new ApprovalError('Too many PIN attempts. Try again in 15 minutes.', 429);
  }
  const db = getDatabase();
  const candidates = db.prepare(
    "SELECT id, role, pin_hash FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL AND role IN ('owner', 'manager')",
  ).all() as { id: string; role: string; pin_hash: string }[];
  const match = candidates.find((u) => verifyPin(u.pin_hash, pin) && hasPermission(u.role, input.permission));
  if (!match) {
    throw new ApprovalError('Invalid manager PIN', 403, true);
  }
  return { userId: match.id, role: match.role, via: 'pin' };
}
