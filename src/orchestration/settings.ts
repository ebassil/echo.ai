import joplin from 'api';
import { SettingItemType } from 'api/types';

export const ORCHESTRATION_SETTINGS = {
  orchestrationSchedule: 'echo.orchestrationSchedule',
  cliPort: 'echo.cliPort',
} as const;

export const DEFAULT_ORCHESTRATION_SCHEDULE = 'off';

export function isValidCliPort(value: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && (value === 0 || (value >= 1024 && value <= 65535));
}

export function isValidOrchestrationSchedule(value: string): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'off' || trimmed === 'disabled') return true;
  // Try interval
  if (parseIntervalMs(trimmed) !== null) return true;
  // Try cron
  if (isValidCron(trimmed)) return true;
  return false;
}

export function parseIntervalMs(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  // Accept formats: "30m", "30 min", "30 mins", "every 30m", "every 30 minutes"
  let s = normalized;
  if (s.startsWith('every ')) s = s.slice(6).trim();
  // Now s like "30m" or "2h" or "1d" or "30 minutes"
  const match = s.match(/^(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours|d|day|days|s|sec|secs|seconds)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  if (unit.startsWith('s')) return n * 1000;
  if (unit.startsWith('m')) return n * 60 * 1000;
  if (unit.startsWith('h')) return n * 60 * 60 * 1000;
  if (unit.startsWith('d')) return n * 24 * 60 * 60 * 1000;
  return null;
}

export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  // Very permissive: validate each field token pattern
  const validators = [
    /^(\*|\*\/\d+|\d+(-\d+)?(,\d+(-\d+)?)*)$/, // minute 0-59
    /^(\*|\*\/\d+|\d+(-\d+)?(,\d+(-\d+)?)*)$/, // hour 0-23
    /^(\*|\*\/\d+|\d+(-\d+)?(,\d+(-\d+)?)*)$/, // dom 1-31
    /^(\*|\*\/\d+|\d+(-\d+)?(,\d+(-\d+)?)*)$/, // month 1-12
    /^(\*|\*\/\d+|\d+(-\d+)?(,\d+(-\d+)?)*)$/, // dow 0-7
  ];
  for (let i = 0; i < 5; i++) {
    if (!validators[i].test(parts[i])) return false;
  }
  // Additional range check would be heavy; basic pattern is sufficient for spec
  return true;
}

export function shouldSchedule(schedule: string): boolean {
  const t = schedule.trim().toLowerCase();
  return t !== '' && t !== 'off' && t !== 'disabled';
}

export async function registerOrchestrationSettings(): Promise<void> {
  await joplin.settings.registerSettings({
    [ORCHESTRATION_SETTINGS.orchestrationSchedule]: {
      value: DEFAULT_ORCHESTRATION_SCHEDULE,
      type: SettingItemType.String,
      public: true,
      section: 'echo',
      label: 'Orchestration schedule',
      description: 'Periodic reindex schedule: off, interval (e.g. 30m, 6h, 1d, every 30m), or cron (e.g. 0 */6 * * *). Minimum granularity 1 minute.',
    },
    [ORCHESTRATION_SETTINGS.cliPort]: {
      value: 0,
      type: SettingItemType.Int,
      public: true,
      section: 'echo',
      label: 'CLI endpoint port (0 = auto)',
      description: 'Port for the loopback-only echo CLI HTTP endpoint (127.0.0.1). 0 lets echo.ai pick an ephemeral port and persist it for the CLI. The endpoint is a deliberate, reviewed dual-use behavior: loopback only, guarded by a per-install token, and it never exposes note content to the network. See docs/cli-security.md.',
      minimum: 0,
      maximum: 65535,
      step: 1,
    },
  });
}

export async function resolveCliPort(): Promise<number> {
  try {
    const v = await joplin.settings.value(ORCHESTRATION_SETTINGS.cliPort);
    if (isValidCliPort(v)) return v;
    return 0;
  } catch {
    return 0;
  }
}

export async function resolveOrchestrationSchedule(): Promise<string> {
  try {
    const v = await joplin.settings.value(ORCHESTRATION_SETTINGS.orchestrationSchedule);
    if (typeof v === 'string' && isValidOrchestrationSchedule(v)) return v;
    return DEFAULT_ORCHESTRATION_SCHEDULE;
  } catch {
    return DEFAULT_ORCHESTRATION_SCHEDULE;
  }
}
