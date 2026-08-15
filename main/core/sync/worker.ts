/**
 * Plemmo Core — background sync worker (SYNC-C, Part F).
 *
 * A small, production-safe worker that drives the existing explicit upload /
 * download functions on a timer. It adds NO new sync logic — every durability
 * and idempotency guarantee still lives in the outbox/uploader/downloader; the
 * worker only decides *when* to call them.
 *
 * Design guarantees:
 *   - Non-blocking & cashiering-safe: work happens on a timer, off the request
 *     path; batches are bounded; it only runs when sync is enabled; a slow or
 *     dead cloud never blocks a sale (better-sqlite3 writes are the POS's, the
 *     network calls are the worker's, and the worker holds no long locks).
 *   - Re-entrancy guard: a tick already in flight is never started again, so
 *     ticks cannot overlap or double-upload.
 *   - Restart-safe: each tick's uploader first recovers events stuck
 *     `uploading` from a prior crash back to `pending` (SYNC-A recovery).
 *   - Backoff: the interval grows exponentially on failure up to a cap and
 *     resets on success — no retry storm, but never gives up (offline-first).
 *   - Clean shutdown: `stop()` clears the timer and awaits any in-flight tick.
 *
 * `tick()` is public so tests can drive it deterministically without real
 * timers.
 */

import type Database from 'better-sqlite3';
import { getDatabase } from '../../db';
import { SyncTransport, SyncPullTransport, SyncTransportError } from './types';
import { uploadPendingBatch } from './uploader';
import { pullAndApply } from './downloader';
import { workerLiveness } from './health';

export interface SyncWorkerOptions {
  transport: SyncTransport & SyncPullTransport;
  deviceId: string;
  db?: Database.Database;
  baseIntervalMs?: number;
  maxIntervalMs?: number;
  uploadLimit?: number;
  pullLimit?: number;
}

export interface TickOutcome {
  uploaded: number;
  applied: number;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export class SyncWorker {
  private transport: SyncTransport & SyncPullTransport;
  private deviceId: string;
  private db: Database.Database;
  private baseIntervalMs: number;
  private maxIntervalMs: number;
  private uploadLimit: number;
  private pullLimit: number;

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private inFlight: Promise<TickOutcome> | null = null;
  private stopped = true;
  private currentIntervalMs: number;
  private consecutiveFailures = 0;

  constructor(options: SyncWorkerOptions) {
    this.transport = options.transport;
    this.deviceId = options.deviceId;
    this.db = options.db ?? getDatabase();
    this.baseIntervalMs = options.baseIntervalMs ?? 15_000;
    this.maxIntervalMs = options.maxIntervalMs ?? 5 * 60_000;
    this.uploadLimit = options.uploadLimit ?? 100;
    this.pullLimit = options.pullLimit ?? 100;
    this.currentIntervalMs = this.baseIntervalMs;
  }

  get running(): boolean { return !this.stopped; }
  get intervalMs(): number { return this.currentIntervalMs; }
  get failures(): number { return this.consecutiveFailures; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.inFlight) { try { await this.inFlight; } catch { /* already recorded */ } }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.runScheduledTick(); }, delayMs);
    // Do not keep the event loop alive solely for sync (clean app shutdown).
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private async runScheduledTick(): Promise<void> {
    if (this.stopped) return;
    await this.tick();
    this.scheduleNext(this.currentIntervalMs);
  }

  /** One upload+download cycle. Safe to call directly (tests). Never throws. */
  async tick(): Promise<TickOutcome> {
    if (this.ticking && this.inFlight) return this.inFlight; // re-entrancy guard
    this.ticking = true;
    this.inFlight = this.doTick();
    try {
      return await this.inFlight;
    } finally {
      this.ticking = false;
      this.inFlight = null;
    }
  }

  private async doTick(): Promise<TickOutcome> {
    const started = Date.now();
    let uploaded = 0;
    let applied = 0;
    try {
      const up = await uploadPendingBatch(this.transport, this.deviceId, this.uploadLimit, this.db);
      uploaded = up.acked;
      if (up.transportError) throw new SyncTransportError(up.transportError, 'transient');

      const down = await pullAndApply(this.transport, this.deviceId, this.pullLimit, this.db);
      applied = down.applied;

      // Success: reset backoff.
      this.consecutiveFailures = 0;
      this.currentIntervalMs = this.baseIntervalMs;
      return this.finish({ uploaded, applied, ok: true, durationMs: Date.now() - started });
    } catch (error) {
      // Failure: exponential backoff up to the cap. Never crash the worker.
      this.consecutiveFailures += 1;
      this.currentIntervalMs = Math.min(this.currentIntervalMs * 2, this.maxIntervalMs);
      return this.finish({ uploaded, applied, ok: false, error: (error as Error).message, durationMs: Date.now() - started });
    }
  }

  private finish(outcome: TickOutcome): TickOutcome {
    workerLiveness.lastTickAt = new Date().toISOString();
    workerLiveness.lastDurationMs = outcome.durationMs;
    return outcome;
  }
}
