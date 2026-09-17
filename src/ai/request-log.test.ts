import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ModelRequestLog } from './request-log';

describe('ModelRequestLog', () => {
  it('stores operational records without prompt or answer content', () => {
    const log = new ModelRequestLog();
    log.append({
      requestId: 'req-1',
      startedAt: 1,
      alias: 'page-fast',
      success: true,
      latencyMs: 12,
    });

    const [record] = log.list();
    assert.equal(record.requestId, 'req-1');
    assert.equal(record.alias, 'page-fast');
    assert.equal(record.success, true);
    assert.equal('messages' in record, false);
    assert.equal('text' in record, false);
    assert.equal('referencedTargets' in record, false);
  });

  it('drops the oldest records when the bound is exceeded', () => {
    const log = new ModelRequestLog(2);
    log.append({ requestId: 'a', startedAt: 1, alias: 'page-fast', success: true });
    log.append({ requestId: 'b', startedAt: 2, alias: 'page-fast', success: true });
    log.append({ requestId: 'c', startedAt: 3, alias: 'page-fast', success: true });

    assert.deepEqual(
      log.list().map((record) => record.requestId),
      ['b', 'c'],
    );
  });
});
