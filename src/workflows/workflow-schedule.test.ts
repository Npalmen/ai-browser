import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_RECURRING_CALENDAR_SCAN_DAYS,
  MAX_WALL_CLOCK_UTC_OFFSET_MINUTES,
  addUtcCalendarDays,
  assertSupportedTimeZone,
  canonicalUtcInstant,
  evaluateWorkflowSchedule,
  isoWeekdayMondayFirst,
  resolveLocalWallClock,
  scheduledTriggerKey,
  WorkflowScheduleError,
} from './workflow-schedule';

describe('workflow schedule calculator', () => {
  it('locks bounded UTC search and calendar scan constants', () => {
    assert.equal(MAX_WALL_CLOCK_UTC_OFFSET_MINUTES, 16 * 60);
    assert.equal(MAX_RECURRING_CALENDAR_SCAN_DAYS, 14);
  });

  it('canonicalizes UTC instants and scheduled trigger keys', () => {
    assert.equal(canonicalUtcInstant('2026-09-19T08:00:00Z'), '2026-09-19T08:00:00.000Z');
    assert.equal(
      scheduledTriggerKey('wf-1', '2026-09-19T08:00:00Z'),
      'wf-1:2026-09-19T08:00:00.000Z',
    );
  });

  it('validates runtime IANA timezones without falling back', () => {
    assertSupportedTimeZone('UTC');
    assertSupportedTimeZone('Europe/Stockholm');
    assertSupportedTimeZone('America/New_York');
    assertSupportedTimeZone('Asia/Kathmandu');
    assert.throws(
      () => assertSupportedTimeZone('Mars/Olympus_Mons'),
      (error: unknown) =>
        error instanceof WorkflowScheduleError && error.code === 'WORKFLOW_SCHEDULE_INVALID_TIME_ZONE',
    );
  });

  it('uses UTC calendar arithmetic and ISO weekdays Monday=1', () => {
    const sunday = addUtcCalendarDays({ year: 2026, month: 9, day: 19 }, 1);
    assert.deepEqual(sunday, { year: 2026, month: 9, day: 20 });
    assert.equal(isoWeekdayMondayFirst({ year: 2026, month: 9, day: 19 }), 6);
    assert.equal(isoWeekdayMondayFirst({ year: 2026, month: 9, day: 20 }), 7);
    assert.equal(isoWeekdayMondayFirst({ year: 2026, month: 9, day: 21 }), 1);
  });

  it('returns null for a manual trigger', () => {
    assert.deepEqual(evaluateWorkflowSchedule({ kind: 'manual' }, utc('2026-09-19T10:00:00.000Z')), {
      latestDue: null,
      nextFuture: null,
    });
  });

  it('evaluates one-time before, exact, and overdue instants', () => {
    const runAt = '2026-09-19T12:00:00.000Z';
    const trigger = { kind: 'schedule' as const, schedule: { kind: 'one-time' as const, runAtUtc: runAt } };
    assert.deepEqual(evaluateWorkflowSchedule(trigger, utc('2026-09-19T11:59:59.999Z')), {
      latestDue: null,
      nextFuture: runAt,
    });
    assert.deepEqual(evaluateWorkflowSchedule(trigger, utc(runAt)), {
      latestDue: runAt,
      nextFuture: null,
    });
    assert.deepEqual(evaluateWorkflowSchedule(trigger, utc('2026-09-19T12:00:00.001Z')), {
      latestDue: runAt,
      nextFuture: null,
    });
  });

  it('canonicalizes one-time runAtUtc without milliseconds', () => {
    const trigger = {
      kind: 'schedule' as const,
      schedule: { kind: 'one-time' as const, runAtUtc: '2026-09-19T12:00:00Z' },
    };
    assert.deepEqual(evaluateWorkflowSchedule(trigger, utc('2026-09-19T12:00:00.000Z')), {
      latestDue: '2026-09-19T12:00:00.000Z',
      nextFuture: null,
    });
  });

  it('resolves UTC and Kathmandu wall clocks to canonical UTC', () => {
    assert.equal(
      resolveLocalWallClock('UTC', 2026, 9, 19, 9, 0),
      '2026-09-19T09:00:00.000Z',
    );
    assert.equal(
      resolveLocalWallClock('Asia/Kathmandu', 2026, 9, 19, 9, 0),
      '2026-09-19T03:15:00.000Z',
    );
  });

  it('skips the Stockholm 2026 spring-forward gap and does not shift', () => {
    assert.equal(resolveLocalWallClock('Europe/Stockholm', 2026, 3, 29, 2, 30), null);
    const trigger = daily('Europe/Stockholm', 2, 30);
    const evaluation = evaluateWorkflowSchedule(trigger, utc('2026-03-29T12:00:00.000Z'));
    assert.equal(evaluation.latestDue, '2026-03-28T01:30:00.000Z');
    assert.equal(evaluation.nextFuture, '2026-03-30T00:30:00.000Z');
  });

  it('selects the first Stockholm 2026 fall-back occurrence', () => {
    assert.equal(
      resolveLocalWallClock('Europe/Stockholm', 2026, 10, 25, 2, 30),
      '2026-10-25T00:30:00.000Z',
    );
  });

  it('applies New York 2026 DST gap and overlap independently of Europe', () => {
    assert.equal(resolveLocalWallClock('America/New_York', 2026, 3, 8, 2, 30), null);
    assert.equal(
      resolveLocalWallClock('America/New_York', 2026, 11, 1, 1, 30),
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('evaluates daily slots with minute-precision canonical instants', () => {
    const trigger = daily('Europe/Stockholm', 9, 0);
    assert.deepEqual(evaluateWorkflowSchedule(trigger, utc('2026-09-19T06:00:00.500Z')), {
      latestDue: '2026-09-18T07:00:00.000Z',
      nextFuture: '2026-09-19T07:00:00.000Z',
    });
    assert.deepEqual(evaluateWorkflowSchedule(trigger, utc('2026-09-19T07:00:00.000Z')), {
      latestDue: '2026-09-19T07:00:00.000Z',
      nextFuture: '2026-09-20T07:00:00.000Z',
    });
    assert.deepEqual(evaluateWorkflowSchedule(trigger, utc('2026-09-19T10:00:00.000Z')), {
      latestDue: '2026-09-19T07:00:00.000Z',
      nextFuture: '2026-09-20T07:00:00.000Z',
    });
  });

  it('evaluates weekly ISO weekdays including Sunday/Monday local midnight', () => {
    const monday = weekly('Europe/Stockholm', 9, 0, [1]);
    assert.deepEqual(evaluateWorkflowSchedule(monday, utc('2026-09-20T21:30:00.000Z')), {
      latestDue: '2026-09-14T07:00:00.000Z',
      nextFuture: '2026-09-21T07:00:00.000Z',
    });
    assert.deepEqual(evaluateWorkflowSchedule(monday, utc('2026-09-20T22:30:00.000Z')), {
      latestDue: '2026-09-14T07:00:00.000Z',
      nextFuture: '2026-09-21T07:00:00.000Z',
    });
    assert.deepEqual(evaluateWorkflowSchedule(monday, utc('2026-09-21T07:00:00.000Z')), {
      latestDue: '2026-09-21T07:00:00.000Z',
      nextFuture: '2026-09-28T07:00:00.000Z',
    });
    const mondayFriday = weekly('Europe/Stockholm', 9, 0, [1, 5]);
    assert.deepEqual(evaluateWorkflowSchedule(mondayFriday, utc('2026-09-17T10:00:00.000Z')), {
      latestDue: '2026-09-14T07:00:00.000Z',
      nextFuture: '2026-09-18T07:00:00.000Z',
    });
  });

  it('fails closed on malformed weekly days without normalizing', () => {
    const trigger = weekly('UTC', 9, 0, [1, 1]);
    assert.throws(
      () => evaluateWorkflowSchedule(trigger, utc('2026-09-19T10:00:00.000Z')),
      (error: unknown) =>
        error instanceof WorkflowScheduleError && error.code === 'WORKFLOW_SCHEDULE_INVALID',
    );
    assert.throws(
      () => evaluateWorkflowSchedule(weekly('UTC', 9, 0, []), utc('2026-09-19T10:00:00.000Z')),
      (error: unknown) =>
        error instanceof WorkflowScheduleError && error.code === 'WORKFLOW_SCHEDULE_INVALID',
    );
  });
});

function utc(iso: string): Date {
  return new Date(iso);
}

function daily(timeZone: string, hour: number, minute: number) {
  return {
    kind: 'schedule' as const,
    schedule: { kind: 'recurring-daily' as const, timeZone, hour, minute },
  };
}

function weekly(timeZone: string, hour: number, minute: number, daysOfWeek: readonly number[]) {
  return {
    kind: 'schedule' as const,
    schedule: { kind: 'recurring-weekly' as const, timeZone, hour, minute, daysOfWeek },
  };
}
