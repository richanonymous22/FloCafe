/**
 * Plemmo Core — collision-safe distributed identifiers (ULID).
 *
 * ## The problem this solves
 *
 * FloCafe gives `orders`, `order_items` and `bills` an
 * `INTEGER PRIMARY KEY AUTOINCREMENT`. That is fine for one till and fatal for
 * several: two tills trading offline both mint order id 41, and when they
 * later converge those two different sales claim the same identity. Nothing
 * downstream can tell them apart — not the sync engine, not a report, not a
 * refund looking up its original sale.
 *
 * ## Why ULID rather than UUIDv4
 *
 * Both are collision-safe without coordination, which is the hard requirement.
 * ULID additionally sorts lexicographically by creation time, which matters
 * here for three practical reasons:
 *
 *   - SQLite indexes on a time-ordered TEXT key stay dense instead of
 *     scattering inserts across the B-tree, which is the difference between a
 *     till staying quick and slowly degrading over a year of trading.
 *   - "Most recent sales" and sync cursors become ordinary range scans on the
 *     primary key, with no secondary index on a timestamp.
 *   - Reading a log, an ID that sorts by time is far easier to reason about
 *     than a random one.
 *
 * The `uuid` package is already a dependency and stays where it is used. This
 * module is implemented in-repo rather than adding a `ulid` dependency: the
 * spec is short and stable, this is financial-identity code that a commercial
 * product should own outright, and it avoids another supply-chain edge in a
 * codebase we are deliberately keeping licence-clean.
 *
 * ## Format (per the ULID spec)
 *
 *   26 characters, Crockford Base32, no padding
 *   ┌───────────────┬──────────────────────┐
 *   │ 10 chars      │ 16 chars             │
 *   │ 48-bit ms     │ 80 bits randomness   │
 *   └───────────────┴──────────────────────┘
 *
 * Randomness comes from `crypto.randomBytes`, never `Math.random` — this is
 * an identifier for financial records.
 *
 * ## Monotonicity
 *
 * Within a single millisecond the random component is incremented rather than
 * re-drawn, so IDs minted in a tight loop (an order and its twenty lines) stay
 * strictly increasing and therefore stay in insertion order. This is the
 * behaviour the spec calls "monotonic".
 *
 * ## Status in Phase 1
 *
 * This module is the foundation only. Existing integer primary keys are NOT
 * being converted yet — that is a wide, breaking change across every join,
 * report and the KDS protocol. Phase 1 instead attaches a ULID `uid` column
 * alongside the existing keys so every sale, line and bill already carries a
 * globally unique identity that a future sync engine can key on. See
 * docs/PLEMMO_ARCHITECTURE.md § Identifiers for the staged plan.
 */

import * as crypto from 'crypto';

/** Crockford Base32: excludes I, L, O and U to avoid transcription errors. */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
export const ULID_LENGTH = TIME_LEN + RANDOM_LEN;

/** Largest timestamp a 48-bit millisecond field can hold (year 10889). */
const MAX_TIME = 281474976710655;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError(`Timestamp out of ULID range: ${now}`);
  }
  let out = '';
  let remaining = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = remaining % ENCODING_LEN;
    out = ENCODING[mod] + out;
    remaining = (remaining - mod) / ENCODING_LEN;
  }
  return out;
}

/** 16 Crockford symbols = 80 bits, drawn from the CSPRNG. */
function drawRandom(): number[] {
  const bytes = crypto.randomBytes(RANDOM_LEN);
  const out = new Array<number>(RANDOM_LEN);
  for (let i = 0; i < RANDOM_LEN; i++) {
    // Take the low 5 bits of each byte. Uniform over 0..31 because 32 divides
    // 256 exactly, so there is no modulo bias to correct for.
    out[i] = bytes[i] & 0x1f;
  }
  return out;
}

/**
 * Increment the random component by one, with carry, for monotonic IDs inside
 * the same millisecond. Overflowing all 80 bits is not reachable in practice
 * (it needs 2^80 IDs in one millisecond) but is handled rather than silently
 * wrapping to a smaller value, which would break ordering.
 */
function incrementRandom(values: number[]): number[] {
  const out = values.slice();
  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    if (out[i] < ENCODING_LEN - 1) {
      out[i]++;
      return out;
    }
    out[i] = 0;
  }
  throw new Error('ULID random component overflowed within a single millisecond');
}

/**
 * Generate a ULID.
 *
 * @param seedTime Optional millisecond timestamp, for tests and for stamping a
 *                 record with a known time. Omit in production code.
 */
export function ulid(seedTime?: number): string {
  const now = seedTime === undefined ? Date.now() : seedTime;
  if (!Number.isInteger(now)) throw new TypeError(`ULID seed time must be an integer, got ${now}`);

  if (now === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    // A clock that steps backwards (NTP correction, a manual change on a till)
    // must not produce IDs that collide with ones already issued. Holding the
    // last timestamp and continuing to increment keeps them unique and ordered
    // until the wall clock catches up.
    if (now < lastTime) {
      lastRandom = incrementRandom(lastRandom);
    } else {
      lastTime = now;
      lastRandom = drawRandom();
    }
  }

  const timePart = encodeTime(now > lastTime ? now : lastTime);
  let randomPart = '';
  for (let i = 0; i < RANDOM_LEN; i++) randomPart += ENCODING[lastRandom[i]];
  return timePart + randomPart;
}

/** True when `value` is a syntactically valid 26-character Crockford ULID. */
export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

/** Extract the creation timestamp (ms since epoch) encoded in a ULID. */
export function ulidTime(value: string): number {
  if (!isUlid(value)) throw new TypeError(`Not a valid ULID: ${JSON.stringify(value)}`);
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const index = ENCODING.indexOf(value[i]);
    if (index === -1) throw new TypeError(`Invalid ULID character: ${value[i]}`);
    time = time * ENCODING_LEN + index;
  }
  return time;
}

/**
 * Reset the monotonic state. Tests only — production code must never call
 * this, because it removes the guarantee that two IDs minted in the same
 * millisecond are ordered.
 */
export function __resetUlidStateForTests(): void {
  lastTime = -1;
  lastRandom = [];
}
