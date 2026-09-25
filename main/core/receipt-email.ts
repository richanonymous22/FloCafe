/**
 * Digital-receipt email transport (B2 productization).
 *
 * Provider-agnostic by design. The desktop build ships with NO transport
 * configured, so `createReceiptEmailTransport()` returns null and the deliver
 * route falls back to recording the request (the existing, honest behaviour —
 * never a silent claim that mail was sent).
 *
 * When `PLEMMO_EMAIL_TRANSPORT=http` is set, receipts are POSTed as JSON to
 * `PLEMMO_EMAIL_WEBHOOK_URL` (your provider's HTTP API or a thin relay in front
 * of SendGrid / Mailgun / SES / SMTP), with an optional bearer token from
 * `PLEMMO_EMAIL_WEBHOOK_TOKEN` and an optional `PLEMMO_EMAIL_FROM` sender. This
 * keeps the client dependency-free (uses global fetch) and lets any email
 * provider be plugged in without a code change.
 *
 * Payload shape POSTed to the webhook:
 *   { "to": string, "from": string|null, "subject": string,
 *     "text": string, "html": string|null }
 * A 2xx response means accepted; a JSON body may return { id | messageId }
 * which is stored as the provider message id.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
}

export interface EmailSendResult {
  ok: boolean;
  providerMessageId?: string | null;
  error?: string;
}

export interface ReceiptEmailTransport {
  send(msg: EmailMessage): Promise<EmailSendResult>;
}

/** RFC-5322-lite address check — good enough to reject obviously invalid input. */
export function isValidEmail(address: string): boolean {
  return typeof address === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim());
}

class HttpEmailTransport implements ReceiptEmailTransport {
  constructor(
    private readonly url: string,
    private readonly token: string | null,
    private readonly from: string | null,
  ) {}

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    const body = JSON.stringify({ to: msg.to, from: this.from, subject: msg.subject, text: msg.text, html: msg.html ?? null });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    // One retry on a transient failure (network error or 5xx). 4xx is terminal.
    let lastError = 'unknown error';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let res: Response;
        try {
          res = await fetch(this.url, { method: 'POST', headers, body, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        if (res.ok) {
          let providerMessageId: string | null = null;
          try {
            const json = (await res.json()) as Record<string, unknown>;
            providerMessageId = (json.id as string) ?? (json.messageId as string) ?? null;
          } catch { /* non-JSON 2xx is still a success */ }
          return { ok: true, providerMessageId };
        }
        lastError = `provider responded ${res.status}`;
        if (res.status < 500) return { ok: false, error: lastError }; // 4xx: don't retry
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    return { ok: false, error: lastError };
  }
}

/**
 * Builds the configured transport, or null when none is configured (record-only).
 * Read fresh each call so config/tests can change the environment.
 */
export function createReceiptEmailTransport(): ReceiptEmailTransport | null {
  const kind = (process.env.PLEMMO_EMAIL_TRANSPORT || 'none').toLowerCase();
  if (kind === 'http') {
    const url = process.env.PLEMMO_EMAIL_WEBHOOK_URL;
    if (!url || !url.trim()) return null; // misconfigured → record-only, never crash a sale
    return new HttpEmailTransport(url.trim(), process.env.PLEMMO_EMAIL_WEBHOOK_TOKEN?.trim() || null, process.env.PLEMMO_EMAIL_FROM?.trim() || null);
  }
  return null;
}

/** Subject line for a receipt email, from the business name and order/bill number. */
export function receiptEmailSubject(business: string, reference: string | null): string {
  const ref = reference ? ` ${reference}` : '';
  return `Your receipt from ${business || 'our store'}${ref}`;
}
