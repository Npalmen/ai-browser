import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { BrowserAdapter } from '../browser/browser-adapter';
import { TargetRegistry } from '../observation/target-registry';
import type { PageState } from '../shared/browser-types';
import { InteractionError } from '../shared/interaction-errors';
import type { BoundInteractionProposal } from '../shared/interaction-types';
import type { ObservationNode, PageObservation } from '../shared/observation-types';
import { InMemoryInteractionAuditSink } from './interaction-audit';
import { InteractionExecutor } from './interaction-executor';

const ROOT = path.resolve(__dirname, '..', '..');

function node(overrides: Partial<ObservationNode> & Pick<ObservationNode, 'role'>): ObservationNode {
  return {
    frameId: 'frame-1',
    interactive: true,
    visible: true,
    inViewport: true,
    ...overrides,
  };
}

function observation(nodes: ObservationNode[], revision = 'rev-1'): PageObservation {
  return {
    observationId: 'obs-1',
    tabId: 'tab-1',
    capturedAt: 1,
    document: {
      revision,
      url: 'https://example.com/page',
      title: 'Example',
      loading: false,
      mainFrameId: 'frame-1',
    },
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, deviceScaleFactor: 1 },
    nodes,
    stats: {
      sourceAxNodeCount: nodes.length,
      sourceDomNodeCount: nodes.length,
      emittedNodeCount: nodes.length,
      truncated: false,
      redactedValueCount: 0,
      frameCount: 1,
      crossOriginFrameCount: 0,
    },
  };
}

function pageState(): PageState {
  return {
    tabId: 'tab-1',
    url: 'https://example.com/page',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
}

function record(targetId: string, backendNodeId: number) {
  return {
    targetId,
    tabId: 'tab-1',
    observationId: 'obs-1',
    documentRevision: 'rev-1',
    frameId: 'frame-1',
    backendNodeId,
  };
}

function createFakeAdapter(options: {
  observePage?: () => Promise<PageObservation>;
} = {}): {
  adapter: BrowserAdapter;
  counts: {
    click: number;
    type: number;
    select: number;
    scroll: number;
    scrollIntoView: number;
    observePage: number;
  };
  lastSelectRequest: { current?: import('../browser/interaction-adapter-types').AdapterSelectRequest };
} {
  const counts = {
    click: 0,
    type: 0,
    select: 0,
    scroll: 0,
    scrollIntoView: 0,
    observePage: 0,
  };

  const lastSelectRequest: { current?: import('../browser/interaction-adapter-types').AdapterSelectRequest } =
    {};

  const adapter: BrowserAdapter = {
    createTab: async () => 'tab-1',
    closeTab: async () => undefined,
    activateTab: async () => undefined,
    navigate: async () => undefined,
    back: async () => undefined,
    forward: async () => undefined,
    reload: async () => undefined,
    getPageState: async () => pageState(),
    observePage: async () => {
      counts.observePage += 1;
      if (options.observePage) {
        return options.observePage();
      }
      return observation([
        node({
          role: 'button',
          tag: 'button',
          targetId: 'target-1',
          name: 'After',
          attributes: { type: 'button' },
        }),
      ], 'rev-2');
    },
    click: async () => {
      counts.click += 1;
      return { primitive: 'click' };
    },
    type: async () => {
      counts.type += 1;
      return { primitive: 'type' };
    },
    select: async (request) => {
      counts.select += 1;
      lastSelectRequest.current = request;
      return { primitive: 'select' };
    },
    scroll: async () => {
      counts.scroll += 1;
      return { primitive: 'scroll' };
    },
    scrollIntoView: async () => {
      counts.scrollIntoView += 1;
      return { primitive: 'scroll' };
    },
  };

  return { adapter, counts, lastSelectRequest };
}

function createExecutor(adapter: BrowserAdapter, registry = new TargetRegistry()) {
  const audit = new InMemoryInteractionAuditSink();
  const executor = new InteractionExecutor({
    adapter,
    targetRegistry: registry,
    audit,
    generateActionId: () => 'action-1',
    now: () => 1,
  });
  return { executor, audit, registry };
}

function lastAuditEvent(audit: InMemoryInteractionAuditSink) {
  const events = audit.getEvents();
  assert.ok(events.length > 0);
  return events[events.length - 1];
}

describe('InteractionExecutor', () => {
  it('executes a safe click once and returns a fresh observation', async () => {
    const { adapter, counts } = createFakeAdapter();
    const { executor, audit, registry } = createExecutor(adapter);
    registry.replaceObservation('tab-1', 'obs-1', [record('target-1', 1)]);

    const result = await executor.execute({
      proposal: {
        kind: 'click',
        targetId: 'target-1',
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
      },
      observation: observation([
        node({
          role: 'button',
          tag: 'button',
          targetId: 'target-1',
          name: 'Expand',
          attributes: { type: 'button' },
        }),
      ]),
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.observation?.observationId, 'obs-1');
    assert.equal(result.observation?.document.revision, 'rev-2');
    assert.equal(counts.click, 1);
    assert.equal(counts.observePage, 1);

    const event = lastAuditEvent(audit);
    assert.equal(event.policyOutcome, 'ALLOW_INTERACT');
    assert.equal(event.grantIssued, true);
    assert.equal(event.grantedAuthority, 'INTERACT');
    assert.equal(event.adapterPrimitiveInvoked, true);
    assert.equal(event.resultStatus, 'succeeded');
    assert.equal(event.documentRevisionAfter, 'rev-2');
  });

  it('denies consequential clicks without calling adapter primitives', async () => {
    const { adapter, counts } = createFakeAdapter();
    const { executor, audit, registry } = createExecutor(adapter);
    registry.replaceObservation('tab-1', 'obs-1', [record('target-1', 1)]);

    const result = await executor.execute({
      proposal: {
        kind: 'click',
        targetId: 'target-1',
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
      },
      observation: observation([
        node({
          role: 'button',
          tag: 'button',
          targetId: 'target-1',
          name: 'Buy now',
          attributes: { type: 'button' },
        }),
      ]),
    });

    assert.equal(result.status, 'denied');
    assert.equal(result.errorCode, 'DEFERRED_TO_EXECUTE');
    assert.equal(counts.click, 0);
    assert.equal(counts.type, 0);
    assert.equal(counts.select, 0);
    assert.equal(counts.scroll, 0);
    assert.equal(counts.scrollIntoView, 0);
    assert.equal(counts.observePage, 0);

    const event = lastAuditEvent(audit);
    assert.equal(event.policyOutcome, 'DEFER_EXECUTE');
    assert.equal(event.grantIssued, false);
    assert.equal(event.adapterPrimitiveInvoked, false);
    assert.equal(event.resultStatus, 'denied');
  });

  it('denies ambiguous unsupported controls with policy DENY', async () => {
    const { adapter, counts } = createFakeAdapter();
    const { executor, audit, registry } = createExecutor(adapter);
    registry.replaceObservation('tab-1', 'obs-1', [record('target-1', 1)]);

    const result = await executor.execute({
      proposal: {
        kind: 'click',
        targetId: 'target-1',
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
      },
      observation: observation([
        node({
          role: 'button',
          tag: 'button',
          targetId: 'target-1',
          name: 'Continue',
        }),
      ]),
    });

    assert.equal(result.status, 'denied');
    assert.equal(result.errorCode, 'INTERACTION_DENIED');
    assert.equal(counts.click, 0);

    const event = lastAuditEvent(audit);
    assert.equal(event.policyOutcome, 'DENY');
    assert.equal(event.grantIssued, false);
    assert.equal(event.adapterPrimitiveInvoked, false);
    assert.equal(event.resultStatus, 'denied');
  });

  it('denies sensitive type proposals without calling adapter.type', async () => {
    const { adapter, counts } = createFakeAdapter();
    const { executor, registry } = createExecutor(adapter);
    registry.replaceObservation('tab-1', 'obs-1', [record('target-1', 1)]);

    const result = await executor.execute({
      proposal: {
        kind: 'type',
        targetId: 'target-1',
        text: 'secret',
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
      },
      observation: observation([
        node({
          role: 'textbox',
          tag: 'input',
          targetId: 'target-1',
          states: { editable: true, secret: true },
          attributes: { type: 'password' },
        }),
      ]),
    });

    assert.equal(result.status, 'denied');
    assert.equal(result.errorCode, 'TARGET_SENSITIVE');
    assert.equal(counts.type, 0);
  });

  it('fails stale targets before adapter invocation', async () => {
    const { adapter, counts } = createFakeAdapter();
    const { executor, audit, registry } = createExecutor(adapter);
    registry.replaceObservation('tab-1', 'obs-2', [record('target-1', 1)]);

    const result = await executor.execute({
      proposal: {
        kind: 'click',
        targetId: 'target-1',
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
      },
      observation: observation([
        node({
          role: 'button',
          tag: 'button',
          targetId: 'target-1',
          name: 'Expand',
          attributes: { type: 'button' },
        }),
      ]),
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'TARGET_STALE');
    assert.equal(counts.click, 0);

    const event = lastAuditEvent(audit);
    assert.equal(event.policyOutcome, undefined);
    assert.equal(event.grantIssued, false);
    assert.equal(event.adapterPrimitiveInvoked, false);
    assert.equal(event.resultStatus, 'failed');
  });

  it('denies select when option is not in the select nativeOptions catalog', async () => {
    const { adapter, counts } = createFakeAdapter();
    const { executor, registry } = createExecutor(adapter);
    registry.replaceObservation('tab-1', 'obs-1', [record('select-1', 1), record('option-2', 2)]);

    const result = await executor.execute({
      proposal: {
        kind: 'select',
        targetId: 'select-1',
        optionTargetId: 'option-2',
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
      },
      observation: observation([
        node({
          role: 'combobox',
          tag: 'select',
          targetId: 'select-1',
          nativeOptions: [{ targetId: 'option-1', name: 'Red' }],
        }),
        node({ role: 'option', tag: 'option', targetId: 'option-2', name: 'Blue' }),
      ]),
    });

    assert.equal(result.status, 'denied');
    assert.equal(counts.select, 0);
  });

  it('passes exact option backend identity to the adapter without a catalog index', async () => {
    const { adapter, counts, lastSelectRequest } = createFakeAdapter();
    const { executor, registry } = createExecutor(adapter);
    registry.replaceObservation('tab-1', 'obs-1', [
      record('select-1', 10),
      record('option-a', 11),
      record('option-b', 12),
      record('option-c', 13),
    ]);

    const result = await executor.execute({
      proposal: {
        kind: 'select',
        targetId: 'select-1',
        optionTargetId: 'option-c',
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
      },
      observation: observation([
        node({
          role: 'combobox',
          tag: 'select',
          targetId: 'select-1',
          name: 'Color',
          nativeOptions: [
            { targetId: 'option-a', name: 'A', selected: true },
            { targetId: 'option-c', name: 'C' },
          ],
        }),
        node({ role: 'option', tag: 'option', targetId: 'option-a', name: 'A', states: { selected: true } }),
        node({ role: 'option', tag: 'option', targetId: 'option-c', name: 'C' }),
      ]),
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(counts.select, 1);
    assert.equal(lastSelectRequest.current?.selectTarget.backendNodeId, 10);
    assert.equal(lastSelectRequest.current?.optionTarget.backendNodeId, 13);
    assert.equal(
      lastSelectRequest.current !== undefined && 'optionCatalogIndex' in lastSelectRequest.current,
      false,
    );
  });

  it('executes safe navigation links with NAVIGATE authority', async () => {
    const { adapter, counts } = createFakeAdapter();
    const { executor, registry } = createExecutor(adapter);
    registry.replaceObservation('tab-1', 'obs-1', [record('target-1', 1)]);

    const result = await executor.execute({
      proposal: {
        kind: 'click',
        targetId: 'target-1',
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
      },
      observation: observation([
        node({
          role: 'link',
          tag: 'a',
          targetId: 'target-1',
          name: 'Article',
          attributes: { href: 'https://example.com/article' },
        }),
      ]),
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(counts.click, 1);
    assert.equal(counts.observePage, 1);
  });

  it('executes viewport scroll with NAVIGATE authority and re-observes', async () => {
    const { adapter, counts } = createFakeAdapter();
    const { executor } = createExecutor(adapter);

    const result = await executor.execute({
      proposal: {
        kind: 'scroll',
        mode: 'viewport',
        direction: 'down',
        amountPx: 120,
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
      },
      observation: observation([]),
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(counts.scroll, 1);
    assert.equal(counts.observePage, 1);
    assert.ok(result.observation);
  });

  it('never returns succeeded without a fresh observation', async () => {
    const { adapter } = createFakeAdapter({
      observePage: async () => {
        throw new Error('observe failed');
      },
    });
    const { executor, registry } = createExecutor(adapter);
    registry.replaceObservation('tab-1', 'obs-1', [record('target-1', 1)]);

    const result = await executor.execute({
      proposal: {
        kind: 'click',
        targetId: 'target-1',
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
      },
      observation: observation([
        node({
          role: 'button',
          tag: 'button',
          targetId: 'target-1',
          name: 'Expand',
          attributes: { type: 'button' },
        }),
      ]),
    });

    assert.notEqual(result.status, 'succeeded');
    assert.equal(result.observation, undefined);
  });

  it('does not retry adapter primitives when re-observation fails', async () => {
    const { adapter, counts } = createFakeAdapter({
      observePage: async () => {
        throw new Error('observe failed');
      },
    });
    const { executor, audit, registry } = createExecutor(adapter);
    registry.replaceObservation('tab-1', 'obs-1', [record('target-1', 1)]);

    await executor.execute({
      proposal: {
        kind: 'click',
        targetId: 'target-1',
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
      },
      observation: observation([
        node({
          role: 'button',
          tag: 'button',
          targetId: 'target-1',
          name: 'Expand',
          attributes: { type: 'button' },
        }),
      ]),
    });

    assert.equal(counts.click, 1);
    assert.equal(counts.observePage, 1);

    const event = lastAuditEvent(audit);
    assert.equal(event.policyOutcome, 'ALLOW_INTERACT');
    assert.equal(event.grantIssued, true);
    assert.equal(event.grantedAuthority, 'INTERACT');
    assert.equal(event.adapterPrimitiveInvoked, true);
    assert.equal(event.resultStatus, 'failed');
  });

  it('records adapter failure after allow without rewriting policy to DENY', async () => {
    const { adapter, counts } = createFakeAdapter();
    adapter.click = async () => {
      counts.click += 1;
      throw new InteractionError('INTERACTION_FAILED', 'Adapter click failed.');
    };
    const { executor, audit, registry } = createExecutor(adapter);
    registry.replaceObservation('tab-1', 'obs-1', [record('target-1', 1)]);

    const result = await executor.execute({
      proposal: {
        kind: 'click',
        targetId: 'target-1',
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
      },
      observation: observation([
        node({
          role: 'button',
          tag: 'button',
          targetId: 'target-1',
          name: 'Expand',
          attributes: { type: 'button' },
        }),
      ]),
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'INTERACTION_FAILED');
    assert.equal(counts.click, 1);
    assert.equal(counts.observePage, 0);

    const event = lastAuditEvent(audit);
    assert.equal(event.policyOutcome, 'ALLOW_INTERACT');
    assert.equal(event.grantIssued, true);
    assert.equal(event.grantedAuthority, 'INTERACT');
    assert.equal(event.adapterPrimitiveInvoked, true);
    assert.equal(event.resultStatus, 'failed');
  });

  it('records NAVIGATE adapter failure after allow', async () => {
    const { adapter, counts } = createFakeAdapter();
    adapter.scroll = async () => {
      counts.scroll += 1;
      throw new InteractionError('INTERACTION_FAILED', 'Adapter scroll failed.');
    };
    const { executor, audit } = createExecutor(adapter);

    const result = await executor.execute({
      proposal: {
        kind: 'scroll',
        mode: 'viewport',
        direction: 'down',
        amountPx: 120,
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
      },
      observation: observation([]),
    });

    assert.equal(result.status, 'failed');
    assert.equal(counts.scroll, 1);
    assert.equal(counts.observePage, 0);

    const event = lastAuditEvent(audit);
    assert.equal(event.policyOutcome, 'ALLOW_NAVIGATE');
    assert.equal(event.grantIssued, true);
    assert.equal(event.grantedAuthority, 'NAVIGATE');
    assert.equal(event.adapterPrimitiveInvoked, true);
    assert.equal(event.resultStatus, 'failed');
  });

  it('rejects concurrent execution on the same tab', async () => {
    const { adapter } = createFakeAdapter();
    const { executor, audit, registry } = createExecutor(adapter);
    registry.replaceObservation('tab-1', 'obs-1', [record('target-1', 1)]);

    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    adapter.click = async () => {
      await gate;
      return { primitive: 'click' };
    };

    const obs = observation([
      node({
        role: 'button',
        tag: 'button',
        targetId: 'target-1',
        name: 'Expand',
        attributes: { type: 'button' },
      }),
    ]);

    const first = executor.execute({
      proposal: {
        kind: 'click',
        targetId: 'target-1',
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
      },
      observation: obs,
    });

    const second = await executor.execute({
      proposal: {
        kind: 'click',
        targetId: 'target-1',
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
      },
      observation: obs,
    });

    assert.equal(second.status, 'failed');
    assert.equal(second.errorCode, 'INTERACTION_IN_PROGRESS');
    releaseFirst?.();
    await first;

    const concurrentEvent = audit.getEvents().find((event) => event.errorCode === 'INTERACTION_IN_PROGRESS');
    assert.ok(concurrentEvent);
    assert.equal(concurrentEvent.policyOutcome, undefined);
    assert.equal(concurrentEvent.grantIssued, false);
    assert.equal(concurrentEvent.adapterPrimitiveInvoked, false);
    assert.equal(concurrentEvent.resultStatus, 'failed');
  });
});

describe('interaction adapter boundary', () => {
  function collectTsFiles(directory: string): string[] {
    const entries = readdirSync(directory);
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(directory, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        files.push(...collectTsFiles(full));
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        files.push(full);
      }
    }
    return files;
  }

  it('allows only the executor to call BrowserAdapter interaction primitives', () => {
    const forbiddenCallers = [
      /adapter\.click\(/,
      /adapter\.type\(/,
      /adapter\.select\(/,
      /adapter\.scroll\(/,
      /adapter\.scrollIntoView\(/,
      /this\.click\(/,
      /this\.type\(/,
      /this\.select\(/,
      /this\.scroll\(/,
      /this\.scrollIntoView\(/,
    ];

    const executorPath = path.join(ROOT, 'src', 'interaction', 'interaction-executor.ts');
    const executeExecutorPath = path.normalize(path.join(ROOT, 'src', 'approval', 'execute-executor.ts'));
    const allowedFiles = new Set([
      path.normalize(executorPath),
      path.normalize(path.join(ROOT, 'src', 'browser', 'electron-adapter.ts')),
      path.normalize(path.join(ROOT, 'src', 'browser', 'browser-adapter.ts')),
    ]);

    for (const file of collectTsFiles(path.join(ROOT, 'src'))) {
      const normalized = path.normalize(file);
      if (allowedFiles.has(normalized)) {
        continue;
      }

      const source = readFileSync(file, 'utf8');
      for (const pattern of forbiddenCallers) {
        if (normalized === executeExecutorPath && pattern.source === 'adapter\\.click\\(') {
          continue;
        }
        assert.equal(pattern.test(source), false, `${path.relative(ROOT, file)} must not call interaction primitives`);
      }
    }

    const executeExecutorSource = readFileSync(executeExecutorPath, 'utf8');
    assert.equal(/adapter\.click\(/.test(executeExecutorSource), true);
    assert.equal(/adapter\.type\(/.test(executeExecutorSource), false);
    assert.equal(/adapter\.select\(/.test(executeExecutorSource), false);
    assert.equal(/adapter\.scroll\(/.test(executeExecutorSource), false);
    assert.equal(/adapter\.scrollIntoView\(/.test(executeExecutorSource), false);
  });
});
