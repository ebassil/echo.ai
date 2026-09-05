import { parseIntervalMs, isValidCron, shouldSchedule } from './settings';
import { isVaultLocked } from '../indexing/vault';
import { enqueueRun } from './runner';
import type { TriggerKind } from './types';

export interface SchedulerHandle {
  dispose(): void;
  reschedule(schedule: string): void;
  getSchedule(): string;
}

function parseCronField(value: string, min: number, max: number): Set<number> {
  const set = new Set<number>();
  if (value === '*') {
    for (let i = min; i <= max; i++) set.add(i);
    return set;
  }
  // Handle */step
  if (value.startsWith('*/')) {
    const step = parseInt(value.slice(2), 10);
    for (let i = min; i <= max; i++) if ((i - min) % step === 0) set.add(i);
    return set;
  }
  const parts = value.split(',');
  for (const part of parts) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map((s) => parseInt(s, 10));
      for (let i = a; i <= b; i++) set.add(i);
    } else if (part.includes('/')) {
      // Not fully supported, but handle
      const [base, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      if (base === '*') {
        for (let i = min; i <= max; i++) if ((i - min) % step === 0) set.add(i);
      }
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n)) set.add(n);
    }
  }
  return set;
}

export function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minStr, hourStr, domStr, monthStr, dowStr] = parts;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();

  const minSet = parseCronField(minStr, 0, 59);
  const hourSet = parseCronField(hourStr, 0, 23);
  const domSet = parseCronField(domStr, 1, 31);
  const monthSet = parseCronField(monthStr, 1, 12);
  const dowSet = parseCronField(dowStr, 0, 7);

  // Normalize dow 7 => 0
  const dowNormalized = dow === 7 ? 0 : dow;
  // Check dow: if set contains 0 or 7, treat accordingly
  const dowMatches = dowSet.has(dow) || dowSet.has(dowNormalized) || (dow === 0 && dowSet.has(7));
  // For dom/month, if those fields are *, they always match already via set

  return minSet.has(minute) && hourSet.has(hour) && domSet.has(dom) && monthSet.has(month) && dowMatches;
}

export function createScheduler(initialSchedule: string, onTick: () => void | Promise<void>): SchedulerHandle {
  let schedule = initialSchedule;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let cronTimer: ReturnType<typeof setInterval> | null = null;
  let deferredTick: { schedule: string; at: string } | null = null;

  function clearTimers(): void {
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    if (cronTimer) {
      clearInterval(cronTimer);
      cronTimer = null;
    }
  }

  function register(sched: string): void {
    clearTimers();
    schedule = sched;
    const trimmed = sched.trim().toLowerCase();
    if (!shouldSchedule(trimmed)) return;

    const intervalMs = parseIntervalMs(trimmed);
    if (intervalMs !== null) {
      intervalTimer = setInterval(async () => {
        if (await isVaultLocked()) {
          deferredTick = { schedule: trimmed, at: new Date().toISOString() };
          console.info('[echo] scheduler tick deferred: vault locked');
          return;
        }
        try {
          await onTick();
        } catch (e) {
          console.warn('[echo] scheduler tick failed', e);
        }
      }, intervalMs);
      return;
    }

    if (isValidCron(trimmed)) {
      // Check every 60s
      cronTimer = setInterval(async () => {
        const now = new Date();
        if (!cronMatches(trimmed, now)) return;
        if (await isVaultLocked()) {
          deferredTick = { schedule: trimmed, at: now.toISOString() };
          console.info('[echo] cron tick deferred: vault locked');
          return;
        }
        try {
          await onTick();
        } catch (e) {
          console.warn('[echo] cron tick failed', e);
        }
      }, 60 * 1000);
      return;
    }

    console.warn(`[echo] invalid schedule "${sched}" - scheduler disabled`);
  }

  register(initialSchedule);

  return {
    dispose() {
      clearTimers();
    },
    reschedule(newSchedule: string) {
      register(newSchedule);
    },
    getSchedule() {
      return schedule;
    },
  };
}

// Convenience: create scheduler that enqueues via runner
export function createOrchestrationScheduler(
  initialSchedule: string,
  enqueueFn?: () => Promise<any>,
): SchedulerHandle {
  const tick = async () => {
    const fn = enqueueFn ?? defaultTick;
    await fn();
  };
  return createScheduler(initialSchedule, tick);
}

async function defaultTick(): Promise<void> {
  if (await isVaultLocked()) return;
  await enqueueRun({
    pipeline: 'structural',
    scope: 'all',
    trigger: 'schedule' as TriggerKind,
  });
}

export function flushDeferredTick(scheduler: SchedulerHandle, deferred: { schedule: string; at: string } | null): void {
  // This is handled by vault unlock polling in triggers; scheduler itself just defers.
  // No-op; exposed for testability.
}
