/**
 * Anonymous usage telemetry — independent of cloud sync (sends whether or
 * not this store has cloud sync configured, since it's a separate concern).
 * Enabled by default for new installs. The owner can switch it off at any
 * time in Settings > Privacy. Tier 2 store diagnostics is a separate,
 * explicit opt-in and is never bundled into this stream.
 *
 * anon_id is a random UUID persisted locally (see db.ensureTelemetryAnonId),
 * never a store id, device id, or anything else that ties back to a business.
 * See specs/floadmin.md § Anonymous telemetry for the endpoint contract.
 */

import { app } from 'electron';
import log from 'electron-log';
import { ensureTelemetryAnonId, isTelemetryEnabled, getSettingValue, parseDbTimestamp, upsertTelemetryLastPing } from '../db';

// PLEMMO FORK: the upstream FloCafe endpoint (telemetry.flopos.com) is gone. A
// Plemmo build must never send data to FloPOS infrastructure, so the endpoint is
// supplied by the operator via the PLEMMO_TELEMETRY_URL env var and defaults to
// empty. When empty, telemetry is a hard no-op (see sendEvent) regardless of the
// consent settings. It is doubly inert on Plemmo installs: telemetry_enabled and
// anonymous_data_consent both default to 'false' and migration v67 clears any
// previously-granted consent. See docs/PLEMMO_ARCHITECTURE.md § Deferred.
export const TELEMETRY_URL = (process.env.PLEMMO_TELEMETRY_URL || '').trim();

const REQUEST_TIMEOUT_MS = 8_000;
const DAILY_PING_INTERVAL_MS = 60 * 60_000; // check hourly, send at most once/24h
const DAILY_PING_MIN_GAP_MS = 24 * 60 * 60_000;

let dailyPingTimer: ReturnType<typeof setInterval> | null = null;

export async function sendEvent(eventType: string, payload?: Record<string, unknown>): Promise<boolean> {
  if (!isTelemetryEnabled()) return false;
  // No endpoint configured → never emit. Guarantees a build with no
  // PLEMMO_TELEMETRY_URL cannot contact any telemetry service (incl. FloPOS).
  if (!TELEMETRY_URL) return false;

  try {
    const anonId = ensureTelemetryAnonId();
    const configuredCountry = (getSettingValue('country') || '').trim().toUpperCase();
    const country = /^[A-Z]{2}$/.test(configuredCountry) ? configuredCountry : undefined;
    const response = await fetch(TELEMETRY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anon_id: anonId,
        app: 'plemmo',
        app_version: app.getVersion(),
        event_type: eventType,
        platform: process.platform,
        ...(country ? { country } : {}),
        ...(payload ? { payload } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.debug(`[Flo] telemetry rejected with HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (e) {
    // Telemetry must never disrupt the app or surface to the user.
    log.debug('[Flo] telemetry send failed (non-fatal):', e);
    return false;
  }
}

function maybeSendDailyPing(): void {
  if (!isTelemetryEnabled()) return;

  const lastPingAt = getSettingValue('telemetry_last_ping_at');
  const lastPingMs = lastPingAt ? parseDbTimestamp(lastPingAt).getTime() : NaN;
  const elapsed = isNaN(lastPingMs) ? Infinity : Date.now() - lastPingMs;
  if (elapsed < DAILY_PING_MIN_GAP_MS) return;

  void sendEvent('daily_ping').then((sent) => {
    if (sent) upsertTelemetryLastPing();
  });
}

export const telemetry = {
  start(): void {
    if (dailyPingTimer) {
      clearInterval(dailyPingTimer);
      dailyPingTimer = null;
    }
    void sendEvent('app_launch');
    maybeSendDailyPing();
    dailyPingTimer = setInterval(maybeSendDailyPing, DAILY_PING_INTERVAL_MS);
  },
  stop(): void {
    if (dailyPingTimer) {
      clearInterval(dailyPingTimer);
      dailyPingTimer = null;
    }
  },
};
