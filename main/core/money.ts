/**
 * Plemmo Core — deterministic money.
 *
 * ## Why this exists
 *
 * A POS is a financial system. Every amount it computes has to be exactly
 * reproducible: the same inputs must produce the same pennies on the receipt,
 * in the report, and in the merchant's VAT return, on every machine.
 * IEEE-754 doubles cannot promise that, so all arithmetic here is done on
 * **integer minor units** (pence for GBP, cents for EUR/USD, yen for JPY).
 *
 * ## What this module is NOT
 *
 * It is NOT a schema change. The FloCafe schema stores money in SQLite `REAL`
 * columns across ~33 columns and five tables, and every query in the codebase
 * reads them that way. Converting those columns is a large, cross-cutting
 * change with a wide blast radius, and it is deliberately deferred — see
 * docs/PLEMMO_ARCHITECTURE.md § Money model for the staged plan.
 *
 * This module is the *foundation* that plan depends on: new Plemmo code
 * computes in minor units and converts at the storage boundary, so that when
 * the columns are converted the arithmetic above them does not have to change.
 *
 * ## Relationship to existing code
 *
 * Two correct-but-partial patterns already exist upstream and this module
 * supersedes both for new code:
 *
 *   1. `main/routes/bills.ts` does payment arithmetic in integer cents via
 *      `Math.round(value * 100)`. Correct for 2-decimal currencies, wrong for
 *      the 0- and 3-decimal ones the app already offers (JPY is in
 *      main/countries.ts). `toMinor()` here is currency-aware.
 *   2. `main/services/tax-engine.ts` uses decimal.js at 40-digit precision for
 *      tax rules. That is the right tool for rule evaluation and is NOT
 *      replaced — the tax engine keeps its Decimal pipeline. Convert its
 *      output to minor units at the boundary with `toMinor()`.
 *
 * ## Rounding
 *
 * Rounding mode is always explicit at the call site. There is no ambient
 * default, because "which way does a half go" is a jurisdiction/business rule,
 * not a language detail. UK VAT practice is half-up; the tax packs carry their
 * own `taxRounding.method`, which callers should pass through.
 */

/** An integer number of minor units (pence/cents). Never fractional. */
export type Minor = number;

export type RoundingMode = 'half_up' | 'half_even' | 'floor' | 'ceiling';

/**
 * ISO 4217 currencies whose minor-unit exponent is not the usual 2.
 * Only the ones this product plausibly meets are listed; everything else
 * falls through to 2, which is correct for GBP/EUR/USD and the large majority.
 */
const EXPONENT_0 = new Set([
  'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'PYG', 'RWF', 'UGX', 'VUV', 'XAF', 'XOF', 'XPF', 'KMF', 'DJF', 'GNF', 'BIF',
]);
const EXPONENT_3 = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/**
 * Minor-unit exponent for an ISO 4217 code: GBP → 2 (pence), JPY → 0,
 * KWD → 3. Unknown/blank codes default to 2 rather than throwing, because a
 * misconfigured currency setting must not be able to stop a till from
 * trading — callers that need strictness should validate the code first.
 */
export function minorUnitExponent(currency: string | null | undefined): number {
  const code = String(currency || '').trim().toUpperCase();
  if (EXPONENT_0.has(code)) return 0;
  if (EXPONENT_3.has(code)) return 3;
  return 2;
}

/** 10^n as an exact integer for the small n we deal with (0–3). */
function scale(exponent: number): number {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new RangeError(`Unsupported minor-unit exponent: ${exponent}`);
  }
  return 10 ** exponent;
}

function assertMinor(value: unknown, label = 'amount'): asserts value is Minor {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer number of minor units, got ${String(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} exceeds the safe integer range: ${value}`);
  }
}

/**
 * Parse a major-unit amount into minor units, exactly.
 *
 * Deliberately string-based rather than `Math.round(n * 100)`. The naive form
 * inherits the binary representation error of the input: 1.005 is stored as
 * 1.00499999999999989…, so `Math.round(1.005 * 100)` yields 100, not the 101
 * that half-up rounding of the *written* value requires. Formatting to a
 * decimal string first makes the digits the source of truth, which is what a
 * merchant typing "1.005" means.
 *
 * Accepts a number or a string. Strings are preferred at any boundary where
 * the value originated as text (an API body, a CSV import, a form field),
 * because they have not been through a float yet.
 */
export function toMinor(
  amount: number | string,
  exponent: number,
  mode: RoundingMode = 'half_up',
): Minor {
  const factor = scale(exponent);

  let text: string;
  if (typeof amount === 'string') {
    text = amount.trim();
    if (text === '') throw new TypeError('Cannot convert an empty string to minor units');
  } else {
    if (!Number.isFinite(amount)) {
      throw new TypeError(`Cannot convert a non-finite number to minor units: ${amount}`);
    }
    // 15 significant digits keeps us inside the range where a double round-trips
    // through decimal text unambiguously, while discarding representation noise
    // such as the trailing ...9989 above.
    text = amount.toPrecision(15);
  }

  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(text)) {
    throw new TypeError(`Not a valid decimal amount: ${JSON.stringify(amount)}`);
  }

  // Normalise exponent notation into plain decimal digits.
  if (/e/i.test(text)) text = expandExponential(text);

  const negative = text.startsWith('-');
  if (text[0] === '+' || text[0] === '-') text = text.slice(1);

  const dot = text.indexOf('.');
  const intPart = dot === -1 ? text : text.slice(0, dot);
  const fracPart = dot === -1 ? '' : text.slice(dot + 1);

  const keep = fracPart.slice(0, exponent).padEnd(exponent, '0');
  const rest = fracPart.slice(exponent);

  const whole = Number(intPart || '0') * factor + Number(keep || '0');
  if (!Number.isSafeInteger(whole)) {
    throw new RangeError(`Amount is too large to represent in minor units: ${amount}`);
  }

  const rounded = applyRemainderRounding(whole, rest, mode);
  return negative ? -rounded : rounded;
}

/** Expand "1.5e-3" style input into plain decimal text. */
function expandExponential(text: string): string {
  const n = Number(text);
  // toFixed(20) is well beyond any currency exponent we support and avoids
  // re-introducing exponent notation for very small magnitudes.
  return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Apply `mode` to a truncated integer plus the decimal digits that were cut.
 * `rest` is the discarded fraction as a digit string, e.g. "5" or "4999".
 */
function applyRemainderRounding(whole: number, rest: string, mode: RoundingMode): number {
  if (rest === '' || /^0*$/.test(rest)) return whole;
  switch (mode) {
    case 'floor':
      return whole;
    case 'ceiling':
      return whole + 1;
    case 'half_even':
    case 'half_up': {
      const first = rest.charCodeAt(0) - 48;
      if (first > 5) return whole + 1;
      if (first < 5) return whole;
      // Exactly one half only when nothing follows the 5.
      const isExactHalf = /^50*$/.test(rest);
      if (!isExactHalf) return whole + 1;
      if (mode === 'half_up') return whole + 1;
      return whole % 2 === 0 ? whole : whole + 1;
    }
    default: {
      const exhaustive: never = mode;
      throw new RangeError(`Unknown rounding mode: ${String(exhaustive)}`);
    }
  }
}

/**
 * Convert minor units back to a major-unit number, for display and for the
 * existing REAL storage columns.
 *
 * The result is a double and so is only safe to *present* or to hand to the
 * legacy storage layer — never to compute with. Do arithmetic in minor units
 * and convert once, at the end.
 */
export function fromMinor(minor: Minor, exponent: number): number {
  assertMinor(minor);
  const factor = scale(exponent);
  // Division by a power of ten then rounding to `exponent` places gives the
  // nearest representable double to the exact decimal value.
  return Number((minor / factor).toFixed(exponent));
}

/** Exact decimal text for a minor amount, e.g. (1099, 2) → "10.99". No currency symbol. */
export function formatMinor(minor: Minor, exponent: number): string {
  assertMinor(minor);
  const factor = scale(exponent);
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / factor);
  const frac = abs - whole * factor;
  const text = exponent === 0 ? String(whole) : `${whole}.${String(frac).padStart(exponent, '0')}`;
  return negative ? `-${text}` : text;
}

export function addMinor(...amounts: Minor[]): Minor {
  let total = 0;
  for (const amount of amounts) {
    assertMinor(amount);
    total += amount;
  }
  assertMinor(total, 'sum');
  return total;
}

export function subMinor(a: Minor, b: Minor): Minor {
  assertMinor(a); assertMinor(b);
  return a - b;
}

/**
 * Multiply a minor amount by a whole quantity. Exact — no rounding needed,
 * which is why line extension (unit price × qty) must use this rather than
 * float multiplication.
 */
export function mulMinor(amount: Minor, quantity: number): Minor {
  assertMinor(amount);
  if (!Number.isInteger(quantity)) {
    throw new TypeError(`Quantity must be a whole number, got ${quantity}. Fractional/weighed quantities are not supported yet — see docs/PLEMMO_ARCHITECTURE.md § Deferred.`);
  }
  const result = amount * quantity;
  assertMinor(result, 'product');
  return result;
}

/**
 * Apply a percentage to a minor amount (VAT, a percentage discount, a service
 * charge). Percent may be fractional (e.g. 17.5); the multiplication is done
 * on the exact decimal text, so 20% of 1099 is 219.8 → 220 half-up, never
 * 219.99999999999997.
 */
export function percentOfMinor(amount: Minor, percent: number | string, mode: RoundingMode = 'half_up'): Minor {
  assertMinor(amount);
  // Scale the percentage into an integer numerator over 100 * 10^dp so the
  // whole computation stays in integers.
  const pctText = typeof percent === 'string' ? percent.trim() : String(percent);
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(pctText)) {
    throw new TypeError(`Not a valid percentage: ${JSON.stringify(percent)}`);
  }
  const negative = pctText.startsWith('-');
  const bare = pctText.replace(/^[+-]/, '');
  const dot = bare.indexOf('.');
  const decimals = dot === -1 ? 0 : bare.length - dot - 1;
  const numerator = Number(bare.replace('.', '')) || 0;
  const denominator = 100 * 10 ** decimals;

  const product = amount * numerator;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError('Percentage calculation exceeded the safe integer range');
  }
  const signed = negative ? -product : product;
  return divideRound(signed, denominator, mode);
}

/** Integer division with an explicit rounding mode. Used by percentOfMinor and allocation. */
export function divideRound(numerator: number, denominator: number, mode: RoundingMode = 'half_up'): Minor {
  if (denominator === 0) throw new RangeError('Division by zero');
  const negative = (numerator < 0) !== (denominator < 0);
  const absNum = Math.abs(numerator);
  const absDen = Math.abs(denominator);
  const quotient = Math.floor(absNum / absDen);
  const remainder = absNum - quotient * absDen;

  let result = quotient;
  if (remainder !== 0) {
    const twice = remainder * 2;
    switch (mode) {
      case 'floor': break;
      case 'ceiling': result = quotient + 1; break;
      case 'half_up': result = twice >= absDen ? quotient + 1 : quotient; break;
      case 'half_even':
        if (twice > absDen) result = quotient + 1;
        else if (twice === absDen) result = quotient % 2 === 0 ? quotient : quotient + 1;
        break;
    }
  }
  // 'floor'/'ceiling' are defined on the signed value, so flip for negatives.
  if (negative && remainder !== 0 && (mode === 'floor' || mode === 'ceiling')) {
    result = mode === 'floor' ? result + 1 : result - 1;
  }
  return negative ? -result : result;
}

/**
 * Split `total` across `weights` so that the parts sum **exactly** back to
 * `total`, using the largest-remainder method.
 *
 * This is the function that stops a POS leaking a penny. Splitting a £10.00
 * bill three ways, prorating an order-level discount across lines, or
 * apportioning inclusive VAT over items all have the same failure mode:
 * round each part independently and the parts no longer add up to the whole,
 * so the receipt disagrees with the payment. Here the remainder is
 * distributed deterministically — largest fractional part first, ties broken
 * by original index so the result is stable and reproducible.
 *
 * Zero total, zero weights, and all-zero weights are handled explicitly
 * because they arise in real baskets (a 100% discount, a comped line).
 */
export function allocateMinor(total: Minor, weights: number[]): Minor[] {
  assertMinor(total);
  if (weights.length === 0) return [];
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) {
      throw new RangeError(`Allocation weights must be finite and non-negative, got ${w}`);
    }
  }

  const weightTotal = weights.reduce((sum, w) => sum + w, 0);
  if (weightTotal === 0) {
    // No basis to weight by — put everything on the first slot rather than
    // silently dropping it, and keep the sum invariant.
    const parts = new Array<number>(weights.length).fill(0);
    parts[0] = total;
    return parts;
  }

  const exact = weights.map((w) => (total * w) / weightTotal);
  const floors = exact.map((v) => Math.floor(v));
  let allocated = floors.reduce((sum, v) => sum + v, 0);
  let remainder = total - allocated;

  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => (b.frac - a.frac) || (a.index - b.index));

  const parts = floors.slice();
  // `remainder` is negative when total is negative (a refund allocation).
  const step = remainder >= 0 ? 1 : -1;
  let cursor = 0;
  while (remainder !== 0) {
    parts[order[cursor % order.length].index] += step;
    remainder -= step;
    cursor++;
  }
  return parts;
}

/**
 * Convenience wrapper binding an exponent, so call sites in a
 * single-currency context are not repeating it on every operation.
 */
export function moneyFor(currency: string | null | undefined) {
  const exponent = minorUnitExponent(currency);
  return {
    exponent,
    toMinor: (amount: number | string, mode: RoundingMode = 'half_up') => toMinor(amount, exponent, mode),
    fromMinor: (minor: Minor) => fromMinor(minor, exponent),
    format: (minor: Minor) => formatMinor(minor, exponent),
  };
}
