import type { WorkflowTriggerRecord } from './workflow-store-types';

/**
 * UTC offsets worldwide are about -12h to +14h. Search ±16 hours around the
 * UTC-naive wall-clock probe, at minute granularity (schedules are minute-precise).
 * 16 * 60 * 2 + 1 = 1921 candidate instants, bounded and deterministic.
 */
export const MAX_WALL_CLOCK_UTC_OFFSET_MINUTES = 16 * 60;

/**
 * Daily DST gaps skip one local date. Weekly matching needs at most 7 days plus
 * one skipped gap date. 14 calendar days each direction is a hard stop.
 */
export const MAX_RECURRING_CALENDAR_SCAN_DAYS = 14;

const MINUTE_MS = 60_000;

export type WorkflowScheduleErrorCode =
  | 'WORKFLOW_SCHEDULE_INVALID_TIME_ZONE'
  | 'WORKFLOW_SCHEDULE_INVALID';

export class WorkflowScheduleError extends Error {
  readonly code: WorkflowScheduleErrorCode;

  constructor(code: WorkflowScheduleErrorCode, message: string) {
    super(message);
    this.name = 'WorkflowScheduleError';
    this.code = code;
  }
}

export function isWorkflowScheduleError(error: unknown): error is WorkflowScheduleError {
  return error instanceof WorkflowScheduleError;
}

export interface LocalCalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface WorkflowScheduleEvaluation {
  readonly latestDue: string | null;
  readonly nextFuture: string | null;
}

export function canonicalUtcInstant(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new WorkflowScheduleError('WORKFLOW_SCHEDULE_INVALID', 'UTC instant is invalid.');
  }
  return new Date(parsed).toISOString();
}

export function scheduledTriggerKey(workflowId: string, scheduledForUtc: string): string {
  return `${workflowId}:${canonicalUtcInstant(scheduledForUtc)}`;
}

export function assertSupportedTimeZone(timeZone: string): void {
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new WorkflowScheduleError(
      'WORKFLOW_SCHEDULE_INVALID_TIME_ZONE',
      'Time zone is invalid.',
    );
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new WorkflowScheduleError(
      'WORKFLOW_SCHEDULE_INVALID_TIME_ZONE',
      'Time zone is invalid.',
    );
  }
}

export function addUtcCalendarDays(date: LocalCalendarDate, days: number): LocalCalendarDate {
  const utc = Date.UTC(date.year, date.month - 1, date.day + days);
  const shifted = new Date(utc);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function isoWeekdayMondayFirst(date: LocalCalendarDate): number {
  const jsDay = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

/**
 * Convert a local wall-clock in `timeZone` to a canonical UTC instant.
 * DST spring-forward gaps return null (skip). Fall-back overlaps select the
 * earliest matching UTC instant (first occurrence).
 */
export function resolveLocalWallClock(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string | null {
  assertSupportedTimeZone(timeZone);
  requireHourMinute(hour, minute);
  const formatter = getFormatter(timeZone);
  const probe = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const start = probe - MAX_WALL_CLOCK_UTC_OFFSET_MINUTES * MINUTE_MS;
  const end = probe + MAX_WALL_CLOCK_UTC_OFFSET_MINUTES * MINUTE_MS;
  for (let utc = start; utc <= end; utc += MINUTE_MS) {
    const wall = readWallClock(formatter, utc);
    if (
      wall.year === year &&
      wall.month === month &&
      wall.day === day &&
      wall.hour === hour &&
      wall.minute === minute
    ) {
      return new Date(utc).toISOString();
    }
  }
  return null;
}

export function evaluateWorkflowSchedule(
  trigger: WorkflowTriggerRecord,
  now: Date,
): WorkflowScheduleEvaluation {
  if (trigger.kind === 'manual') {
    return { latestDue: null, nextFuture: null };
  }
  const schedule = trigger.schedule;
  if (schedule.kind === 'one-time') {
    return evaluateOneTime(schedule.runAtUtc, now);
  }
  const allowedDays =
    schedule.kind === 'recurring-weekly' ? requireIsoWeekdays(schedule.daysOfWeek) : null;
  return evaluateRecurring(schedule.timeZone, schedule.hour, schedule.minute, now, allowedDays);
}

function evaluateOneTime(runAtUtc: string, now: Date): WorkflowScheduleEvaluation {
  if (typeof runAtUtc !== 'string' || runAtUtc.length === 0) {
    throw new WorkflowScheduleError('WORKFLOW_SCHEDULE_INVALID', 'One-time schedule is invalid.');
  }
  const canonical = canonicalUtcInstant(runAtUtc);
  if (Date.parse(canonical) <= now.getTime()) {
    return { latestDue: canonical, nextFuture: null };
  }
  return { latestDue: null, nextFuture: canonical };
}

function evaluateRecurring(
  timeZone: string,
  hour: number,
  minute: number,
  now: Date,
  allowedDays: ReadonlySet<number> | null,
): WorkflowScheduleEvaluation {
  assertSupportedTimeZone(timeZone);
  requireHourMinute(hour, minute);
  const formatter = getFormatter(timeZone);
  const nowWall = readWallClock(formatter, now.getTime());
  const today: LocalCalendarDate = { year: nowWall.year, month: nowWall.month, day: nowWall.day };
  const nowMs = now.getTime();

  let latestDue: string | null = null;
  for (let delta = 0; delta <= MAX_RECURRING_CALENDAR_SCAN_DAYS; delta += 1) {
    const date = addUtcCalendarDays(today, -delta);
    if (allowedDays && !allowedDays.has(isoWeekdayMondayFirst(date))) {
      continue;
    }
    const resolved = resolveLocalWallClock(timeZone, date.year, date.month, date.day, hour, minute);
    if (resolved === null) {
      continue;
    }
    if (Date.parse(resolved) <= nowMs) {
      latestDue = resolved;
      break;
    }
  }

  let nextFuture: string | null = null;
  for (let delta = 0; delta <= MAX_RECURRING_CALENDAR_SCAN_DAYS; delta += 1) {
    const date = addUtcCalendarDays(today, delta);
    if (allowedDays && !allowedDays.has(isoWeekdayMondayFirst(date))) {
      continue;
    }
    const resolved = resolveLocalWallClock(timeZone, date.year, date.month, date.day, hour, minute);
    if (resolved === null) {
      continue;
    }
    if (Date.parse(resolved) > nowMs) {
      nextFuture = resolved;
      break;
    }
  }
  if (nextFuture === null) {
    throw new WorkflowScheduleError(
      'WORKFLOW_SCHEDULE_INVALID',
      'Could not find a future scheduled instant.',
    );
  }
  return { latestDue, nextFuture };
}

function requireHourMinute(hour: number, minute: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new WorkflowScheduleError('WORKFLOW_SCHEDULE_INVALID', 'Schedule hour or minute is invalid.');
  }
}

function requireIsoWeekdays(days: readonly number[]): ReadonlySet<number> {
  if (!Array.isArray(days) || days.length === 0) {
    throw new WorkflowScheduleError('WORKFLOW_SCHEDULE_INVALID', 'daysOfWeek is invalid.');
  }
  const unique = new Set<number>();
  for (const day of days) {
    if (!Number.isInteger(day) || day < 1 || day > 7 || unique.has(day)) {
      throw new WorkflowScheduleError('WORKFLOW_SCHEDULE_INVALID', 'daysOfWeek is invalid.');
    }
    unique.add(day);
  }
  return unique;
}

interface WallClockParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function readWallClock(formatter: Intl.DateTimeFormat, utcMs: number): WallClockParts {
  const parts = formatter.formatToParts(new Date(utcMs));
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}
