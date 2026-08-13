/**
 * Test: Plemmo Core money model (main/core/money.ts)
 *
 * Money is the part of an EPOS that must never be "mostly right". These tests
 * target the cases that actually go wrong in POS software: representation
 * error on values a merchant typed, currencies that are not 2-decimal,
 * percentage tax/discount rounding, and — most importantly — splits that have
 * to add back up to the original total exactly.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/plemmo-money.test.ts
 */

import * as assert from 'node:assert';

import {
  minorUnitExponent,
  toMinor,
  fromMinor,
  formatMinor,
  addMinor,
  subMinor,
  mulMinor,
  percentOfMinor,
  divideRound,
  allocateMinor,
  moneyFor,
} from '../main/core/money';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('Test: Plemmo Core money model');
console.log('='.repeat(50));

// ── Currency exponents ──────────────────────────────────────────────────────
console.log('\n1. Currency minor-unit exponents');
check('GBP is 2 (pence)', () => assert.equal(minorUnitExponent('GBP'), 2));
check('EUR/USD are 2', () => {
  assert.equal(minorUnitExponent('EUR'), 2);
  assert.equal(minorUnitExponent('USD'), 2);
});
check('JPY is 0 — the case a hard-coded *100 gets wrong', () => assert.equal(minorUnitExponent('JPY'), 0));
check('KWD/BHD are 3', () => {
  assert.equal(minorUnitExponent('KWD'), 3);
  assert.equal(minorUnitExponent('BHD'), 3);
});
check('lowercase and padding are tolerated', () => assert.equal(minorUnitExponent(' gbp '), 2));
check('unknown/blank falls back to 2 rather than throwing', () => {
  assert.equal(minorUnitExponent('ZZZ'), 2);
  assert.equal(minorUnitExponent(''), 2);
  assert.equal(minorUnitExponent(null), 2);
});

// ── Conversion ──────────────────────────────────────────────────────────────
console.log('\n2. Major -> minor conversion');
check('£0.01 -> 1p', () => assert.equal(toMinor(0.01, 2), 1));
check('£10.99 -> 1099p', () => assert.equal(toMinor(10.99, 2), 1099));
check('£0.00 -> 0p', () => assert.equal(toMinor(0, 2), 0));
check('negative amounts (refunds) round-trip', () => {
  assert.equal(toMinor(-10.99, 2), -1099);
  assert.equal(fromMinor(-1099, 2), -10.99);
});
check('string input is accepted and preferred at text boundaries', () => {
  assert.equal(toMinor('10.99', 2), 1099);
  assert.equal(toMinor('.5', 2), 50);
  assert.equal(toMinor('7', 2), 700);
});
check('JPY has no minor part: ¥1099 -> 1099', () => assert.equal(toMinor(1099, 0), 1099));
check('KWD 3 decimals: 1.234 -> 1234', () => assert.equal(toMinor(1.234, 3), 1234));

check('1.005 rounds half-up to 101p, not 100p (float-representation trap)', () => {
  // Math.round(1.005 * 100) === 100 because 1.005 is stored as
  // 1.00499999999999989. The string-based path must honour the written digits.
  assert.equal(Math.round(1.005 * 100), 100, 'precondition: the naive form really is wrong');
  assert.equal(toMinor(1.005, 2), 101);
  assert.equal(toMinor('1.005', 2), 101);
});
check('2.675 rounds half-up to 268p (the other classic trap)', () => {
  assert.equal(toMinor('2.675', 2), 268);
});
check('excess precision beyond the exponent is rounded, not truncated', () => {
  assert.equal(toMinor('10.994', 2), 1099);
  assert.equal(toMinor('10.996', 2), 1100);
});
check('rounding modes are explicit and honoured', () => {
  assert.equal(toMinor('1.005', 2, 'floor'), 100);
  assert.equal(toMinor('1.001', 2, 'ceiling'), 101);
  assert.equal(toMinor('1.005', 2, 'half_even'), 100, 'half_even rounds .5 to the even neighbour');
  assert.equal(toMinor('1.015', 2, 'half_even'), 102);
});
check('exponential notation is expanded rather than misparsed', () => {
  assert.equal(toMinor('1e2', 2), 10000);
});
check('garbage input is rejected loudly', () => {
  assert.throws(() => toMinor('abc', 2), /valid decimal amount/);
  assert.throws(() => toMinor('', 2), /empty string/);
  assert.throws(() => toMinor(NaN, 2), /non-finite/);
  assert.throws(() => toMinor(Infinity, 2), /non-finite/);
});

console.log('\n3. Minor -> major and formatting');
check('fromMinor is the inverse for representable values', () => {
  assert.equal(fromMinor(1099, 2), 10.99);
  assert.equal(fromMinor(1, 2), 0.01);
  assert.equal(fromMinor(1099, 0), 1099);
});
check('formatMinor renders exact decimal text', () => {
  assert.equal(formatMinor(1099, 2), '10.99');
  assert.equal(formatMinor(5, 2), '0.05');
  assert.equal(formatMinor(0, 2), '0.00');
  assert.equal(formatMinor(-1099, 2), '-10.99');
  assert.equal(formatMinor(1099, 0), '1099');
  assert.equal(formatMinor(1234, 3), '1.234');
});
check('fromMinor rejects a non-integer minor value', () => {
  assert.throws(() => fromMinor(10.5 as number, 2), /integer number of minor units/);
});

// ── Arithmetic ──────────────────────────────────────────────────────────────
console.log('\n4. Arithmetic is exact');
check('adding pennies does not drift (0.1 + 0.2 problem)', () => {
  assert.notEqual(0.1 + 0.2, 0.3, 'precondition: floats really do drift');
  assert.equal(addMinor(toMinor(0.1, 2), toMinor(0.2, 2)), 30);
  assert.equal(fromMinor(addMinor(toMinor(0.1, 2), toMinor(0.2, 2)), 2), 0.3);
});
check('a hundred 1p additions equal exactly £1.00', () => {
  let total = 0;
  for (let i = 0; i < 100; i++) total = addMinor(total, 1);
  assert.equal(total, 100);
  assert.equal(formatMinor(total, 2), '1.00');
});
check('subtraction', () => assert.equal(subMinor(1099, 100), 999));
check('line extension: 3 x £10.99 = £32.97 exactly', () => {
  assert.equal(mulMinor(toMinor(10.99, 2), 3), 3297);
  assert.equal(formatMinor(mulMinor(toMinor(10.99, 2), 3), 2), '32.97');
});
check('mulMinor refuses fractional quantities (weighed goods not supported yet)', () => {
  assert.throws(() => mulMinor(1099, 0.5), /whole number/);
});
check('non-integer minor inputs are rejected', () => {
  assert.throws(() => addMinor(10.5 as number, 1), /integer number of minor units/);
});

// ── Percentages: VAT and discounts ──────────────────────────────────────────
console.log('\n5. Percentages (VAT, discounts)');
check('UK standard rate: 20% of £10.99 = £2.20 (219.8 -> 220 half-up)', () => {
  assert.equal(percentOfMinor(1099, 20), 220);
});
check('UK reduced rate: 5% of £10.99 = £0.55', () => {
  assert.equal(percentOfMinor(1099, 5), 55);
});
check('UK zero rate: 0% of anything is 0', () => {
  assert.equal(percentOfMinor(1099, 0), 0);
});
check('fractional rate: historic 17.5% of £10.99 = £1.92', () => {
  assert.equal(percentOfMinor(1099, 17.5), 192);
});
check('percentage discount off a line', () => {
  assert.equal(percentOfMinor(toMinor(25.00, 2), 10), 250);
  assert.equal(percentOfMinor(toMinor(9.99, 2), 15), 150);
});
check('rounding mode applies to percentages too', () => {
  // 12.5% of 100p is exactly 12.5 -> half_up 13, half_even 12, floor 12.
  assert.equal(percentOfMinor(100, 12.5, 'half_up'), 13);
  assert.equal(percentOfMinor(100, 12.5, 'half_even'), 12);
  assert.equal(percentOfMinor(100, 12.5, 'floor'), 12);
});
check('negative percentages work (surcharge reversal)', () => {
  assert.equal(percentOfMinor(1000, -10), -100);
});
check('a malformed percentage is rejected', () => {
  assert.throws(() => percentOfMinor(1000, 'ten' as unknown as number), /valid percentage/);
});

console.log('\n6. divideRound');
check('half_up / half_even / floor / ceiling on an exact half', () => {
  assert.equal(divideRound(5, 2, 'half_up'), 3);
  assert.equal(divideRound(5, 2, 'half_even'), 2);
  assert.equal(divideRound(5, 2, 'floor'), 2);
  assert.equal(divideRound(5, 2, 'ceiling'), 3);
});
check('negative numerators round consistently', () => {
  assert.equal(divideRound(-5, 2, 'half_up'), -3);
  assert.equal(divideRound(-5, 2, 'floor'), -3);
  assert.equal(divideRound(-5, 2, 'ceiling'), -2);
});
check('division by zero throws', () => assert.throws(() => divideRound(1, 0), /Division by zero/));

// ── Allocation: the penny-leak guard ────────────────────────────────────────
console.log('\n7. Allocation always reconciles (the penny-leak guard)');
check('£10.00 split three ways sums back to exactly £10.00', () => {
  const parts = allocateMinor(1000, [1, 1, 1]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 1000);
  assert.deepEqual(parts, [334, 333, 333]);
});
check('£0.01 split three ways still sums to 1p', () => {
  const parts = allocateMinor(1, [1, 1, 1]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 1);
  assert.deepEqual(parts, [1, 0, 0]);
});
check('an order discount prorates across unequal lines without drift', () => {
  // £5.00 off a basket of £10.00 / £20.00 / £7.55
  const parts = allocateMinor(500, [1000, 2000, 755]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 500, 'the discount must not gain or lose a penny');
  assert.equal(parts.length, 3);
});
check('inclusive VAT apportioned over many lines reconciles', () => {
  const weights = [333, 333, 333, 1];
  const parts = allocateMinor(1000, weights);
  assert.equal(parts.reduce((a, b) => a + b, 0), 1000);
});
check('allocation is deterministic — same input, same output, every run', () => {
  const a = allocateMinor(1000, [1, 1, 1]);
  const b = allocateMinor(1000, [1, 1, 1]);
  assert.deepEqual(a, b);
});
check('ties break by original index, so the result is stable', () => {
  assert.deepEqual(allocateMinor(2, [1, 1, 1]), [1, 1, 0]);
});
check('negative totals (refund allocation) reconcile too', () => {
  const parts = allocateMinor(-1000, [1, 1, 1]);
  assert.equal(parts.reduce((a, b) => a + b, 0), -1000);
});
check('zero total allocates zeros', () => {
  assert.deepEqual(allocateMinor(0, [1, 2, 3]), [0, 0, 0]);
});
check('all-zero weights (fully comped basket) still preserve the total', () => {
  const parts = allocateMinor(500, [0, 0, 0]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 500);
});
check('empty weights returns empty', () => assert.deepEqual(allocateMinor(100, []), []));
check('negative weights are rejected', () => {
  assert.throws(() => allocateMinor(100, [1, -1]), /non-negative/);
});
check('exhaustive: every split of £0.01..£2.00 across 2..5 ways reconciles', () => {
  for (let total = 1; total <= 200; total++) {
    for (let ways = 2; ways <= 5; ways++) {
      const parts = allocateMinor(total, new Array(ways).fill(1));
      const sum = parts.reduce((a, b) => a + b, 0);
      assert.equal(sum, total, `£${total / 100} across ${ways} ways summed to ${sum}`);
    }
  }
});

// ── End-to-end shapes ───────────────────────────────────────────────────────
console.log('\n8. Realistic end-to-end sale arithmetic');
check('2 x £4.99 + 20% VAT, 10% discount, reconciles to the penny', () => {
  const gbp = moneyFor('GBP');
  const lineNet = mulMinor(gbp.toMinor('4.99'), 2);        // 998
  const discount = percentOfMinor(lineNet, 10);            // 99.8 -> 100
  const netAfter = subMinor(lineNet, discount);            // 898
  const vat = percentOfMinor(netAfter, 20);                // 179.6 -> 180
  const gross = addMinor(netAfter, vat);                   // 1078
  assert.equal(lineNet, 998);
  assert.equal(discount, 100);
  assert.equal(netAfter, 898);
  assert.equal(vat, 180);
  assert.equal(gross, 1078);
  assert.equal(gbp.format(gross), '10.78');
});
check('a refund is the exact negation of the sale', () => {
  const gross = 1078;
  const refund = subMinor(0, gross);
  assert.equal(refund, -1078);
  assert.equal(addMinor(gross, refund), 0, 'sale + refund must net to zero');
});
check('moneyFor("JPY") never introduces a fractional part', () => {
  const jpy = moneyFor('JPY');
  assert.equal(jpy.exponent, 0);
  assert.equal(jpy.toMinor('1099'), 1099);
  assert.equal(jpy.format(1099), '1099');
});

console.log(`\n✅ Plemmo money model tests passed (${passed} checks)`);
