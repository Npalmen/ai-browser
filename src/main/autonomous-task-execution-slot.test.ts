import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AutonomousTaskExecutionSlot, AutonomousTaskSlotReservation } from './autonomous-task-execution-slot';

describe('AutonomousTaskExecutionSlot', () => {
  it('reserves one manual owner and rejects a second reservation', () => {
    const slot = new AutonomousTaskExecutionSlot();
    const first = slot.tryReserveManual();
    assert.equal(first?.kind, 'manual');
    assert.equal(slot.tryReserveManual(), undefined);
    assert.equal(slot.tryReserveWorkflow('occ-1'), undefined);
    assert.equal(slot.owner()?.kind, 'manual');
    assert.equal(slot.isFree(), false);
  });

  it('reserves a workflow owner by occurrence identity before any taskId exists', () => {
    const slot = new AutonomousTaskExecutionSlot();
    const reservation = slot.tryReserveWorkflow('occ-1');
    assert.equal(reservation?.kind, 'workflow');
    assert.equal(reservation?.occurrenceId, 'occ-1');
    const owner = slot.owner();
    assert.equal(owner?.kind, 'workflow');
    if (owner?.kind === 'workflow') {
      assert.equal(owner.occurrenceId, 'occ-1');
      assert.equal(owner.taskId, undefined);
    }
    assert.equal(slot.tryReserveManual(), undefined);
  });

  it('binds and releases only the held reservation object', () => {
    const slot = new AutonomousTaskExecutionSlot();
    const held = slot.tryReserveWorkflow('occ-1');
    assert.ok(held);
    slot.bindTaskId(held, 'task-1');
    assert.equal(slot.owner()?.taskId, 'task-1');
    const stale = new AutonomousTaskSlotReservation('manual');
    slot.bindTaskId(stale, 'task-other');
    assert.equal(slot.owner()?.taskId, 'task-1');
    assert.equal(slot.release(stale), false);
    assert.equal(slot.isFree(), false);
    assert.equal(slot.release(held), true);
    assert.equal(slot.isFree(), true);
    assert.equal(slot.owner(), undefined);
  });

  it('rejects empty workflow occurrence ids', () => {
    const slot = new AutonomousTaskExecutionSlot();
    assert.equal(slot.tryReserveWorkflow(''), undefined);
    assert.equal(slot.tryReserveWorkflow('   '), undefined);
    assert.equal(slot.isFree(), true);
  });
});
