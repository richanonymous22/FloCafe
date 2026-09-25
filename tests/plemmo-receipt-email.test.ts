/**
 * Digital-receipt email transport (B2 productization).
 *
 * Covers the provider-agnostic HTTP transport: config gating, success with a
 * provider message id, 4xx as terminal (no retry), 5xx then success (one
 * retry), network error then success, and address validation. Pure logic with
 * a stubbed global.fetch — runs under ts-node.
 */
import * as assert from 'node:assert/strict';
import { createReceiptEmailTransport, isValidEmail, receiptEmailSubject } from '../main/core/receipt-email';

type FetchResult = { ok: boolean; status: number; json: () => Promise<unknown> };
const realFetch = global.fetch;

function stubFetch(sequence: Array<FetchResult | Error>): () => number {
  let calls = 0;
  (global as any).fetch = async () => {
    const next = sequence[Math.min(calls, sequence.length - 1)];
    calls++;
    if (next instanceof Error) throw next;
    return next as unknown as Response;
  };
  return () => calls;
}

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> | void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]!; }
  const restore = () => { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; } };
  try { const r = fn(); return r instanceof Promise ? r.finally(restore) : (restore(), r); } catch (e) { restore(); throw e; }
}

async function run() {
  console.log('Testing digital-receipt email transport...');

  // Validators
  assert.ok(isValidEmail('a@b.co'), 'valid email');
  assert.ok(!isValidEmail('nope'), 'invalid email (no @)');
  assert.ok(!isValidEmail('a@b'), 'invalid email (no TLD)');
  assert.equal(receiptEmailSubject('Cafe Flo', 'ORD-1'), 'Your receipt from Cafe Flo ORD-1');
  assert.equal(receiptEmailSubject('', null), 'Your receipt from our store');

  // Not configured → record-only (null transport)
  await withEnv({ PLEMMO_EMAIL_TRANSPORT: undefined }, () => {
    assert.equal(createReceiptEmailTransport(), null, 'no transport by default');
  });
  await withEnv({ PLEMMO_EMAIL_TRANSPORT: 'http', PLEMMO_EMAIL_WEBHOOK_URL: undefined }, () => {
    assert.equal(createReceiptEmailTransport(), null, 'http without URL → record-only, never crash');
  });

  const msg = { to: 'c@example.com', subject: 's', text: 'body' };

  try {
    // Success with provider message id
    await withEnv({ PLEMMO_EMAIL_TRANSPORT: 'http', PLEMMO_EMAIL_WEBHOOK_URL: 'https://relay.example/send', PLEMMO_EMAIL_WEBHOOK_TOKEN: 't' }, async () => {
      const count = stubFetch([{ ok: true, status: 200, json: async () => ({ id: 'msg_1' }) }]);
      const t = createReceiptEmailTransport();
      assert.ok(t, 'transport configured');
      const r = await t!.send(msg);
      assert.deepEqual({ ok: r.ok, id: r.providerMessageId }, { ok: true, id: 'msg_1' }, 'success returns provider id');
      assert.equal(count(), 1, 'one call on success');
    });

    // 4xx is terminal — no retry
    await withEnv({ PLEMMO_EMAIL_TRANSPORT: 'http', PLEMMO_EMAIL_WEBHOOK_URL: 'https://relay.example/send' }, async () => {
      const count = stubFetch([{ ok: false, status: 400, json: async () => ({}) }]);
      const r = await createReceiptEmailTransport()!.send(msg);
      assert.equal(r.ok, false, '4xx fails');
      assert.match(r.error || '', /400/, 'error names status');
      assert.equal(count(), 1, 'no retry on 4xx');
    });

    // 5xx then success — one retry
    await withEnv({ PLEMMO_EMAIL_TRANSPORT: 'http', PLEMMO_EMAIL_WEBHOOK_URL: 'https://relay.example/send' }, async () => {
      const count = stubFetch([{ ok: false, status: 503, json: async () => ({}) }, { ok: true, status: 200, json: async () => ({ messageId: 'msg_2' }) }]);
      const r = await createReceiptEmailTransport()!.send(msg);
      assert.deepEqual({ ok: r.ok, id: r.providerMessageId }, { ok: true, id: 'msg_2' }, '5xx then success');
      assert.equal(count(), 2, 'retried once');
    });

    // Network error then success — one retry
    await withEnv({ PLEMMO_EMAIL_TRANSPORT: 'http', PLEMMO_EMAIL_WEBHOOK_URL: 'https://relay.example/send' }, async () => {
      const count = stubFetch([new Error('ECONNRESET'), { ok: true, status: 202, json: async () => { throw new Error('no body'); } }]);
      const r = await createReceiptEmailTransport()!.send(msg);
      assert.equal(r.ok, true, 'recovers after network error');
      assert.equal(r.providerMessageId, null, 'non-JSON 2xx still succeeds with null id');
      assert.equal(count(), 2, 'retried once');
    });

    // Both attempts fail → terminal failure with last error
    await withEnv({ PLEMMO_EMAIL_TRANSPORT: 'http', PLEMMO_EMAIL_WEBHOOK_URL: 'https://relay.example/send' }, async () => {
      stubFetch([new Error('down'), new Error('still down')]);
      const r = await createReceiptEmailTransport()!.send(msg);
      assert.equal(r.ok, false, 'fails after retry');
      assert.match(r.error || '', /down/, 'reports last error');
    });
  } finally {
    global.fetch = realFetch;
  }

  console.log('✅ Digital-receipt email transport tests passed');
}

run().catch((err) => { console.error(err); process.exit(1); });
