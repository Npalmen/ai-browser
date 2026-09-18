import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiRequestController } from '../main/ai-request-controller';
import { parseAgentModelOutput } from '../ai/interaction-output-schema';
import { TargetRegistry } from '../observation/target-registry';
import { V3_TAB_ID, V3_TYPED_FIXTURE_VALUE } from './fixture-constants';
import { findNativeOption, findNodeByName, parseInteractiveContextFromMessages } from './context-helpers';
import {
  createFakeAdapter,
  createInteractiveChain,
  nativeSelectNodes,
  node,
  observation,
  registryRecord,
} from './chain-fixtures';
import { RecordingInteractionModelRuntime } from './recording-interaction-model-runtime';

function lastAudit(audit: { getEvents(): ReadonlyArray<unknown> }) {
  const events = audit.getEvents();
  assert.ok(events.length > 0);
  return events[events.length - 1] as {
    policyOutcome?: string;
    grantIssued: boolean;
    grantedAuthority?: string;
    adapterPrimitiveInvoked: boolean;
    resultStatus: string;
    documentRevisionAfter?: string;
  };
}

describe('V3 chain acceptance', () => {
  it('executes safe click through validation, binding, policy, grant, adapter, and fresh observation', async () => {
    const expandTarget = 'target-expand';
    const page = observation([
      node({
        role: 'button',
        tag: 'button',
        targetId: expandTarget,
        name: 'Expand details',
        attributes: { type: 'button', 'aria-expanded': 'false' },
      }),
    ]);
    const registry = new TargetRegistry();
    registry.replaceObservation(V3_TAB_ID, page.observationId, [registryRecord(expandTarget, 101)]);
    const { adapter, counts } = createFakeAdapter();
    const runtime = new RecordingInteractionModelRuntime((context) => ({
      kind: 'interaction',
      proposal: {
        kind: 'click',
        targetId: findNodeByName(context, 'Expand details').targetId,
      },
    }));
    const { agent, audit } = createInteractiveChain({
      adapter,
      targetRegistry: registry,
      runtime,
      observation: page,
    });

    const result = await agent.interact({ tabId: V3_TAB_ID, instruction: 'Expand details' });
    assert.equal(result.kind, 'interaction');
    if (result.kind !== 'interaction') {
      return;
    }
    assert.equal(result.result.status, 'succeeded');
    assert.equal(counts.click, 1);
    assert.equal(counts.observePage, 1);

    const event = lastAudit(audit);
    assert.equal(event.policyOutcome, 'ALLOW_INTERACT');
    assert.equal(event.grantIssued, true);
    assert.equal(event.grantedAuthority, 'INTERACT');
    assert.equal(event.adapterPrimitiveInvoked, true);
    assert.equal(event.resultStatus, 'succeeded');
    assert.equal(event.documentRevisionAfter, 'rev-v3-2');
  });

  it('executes safe link navigation with NAVIGATE authority', async () => {
    const linkTarget = 'target-link';
    const page = observation([
      node({
        role: 'link',
        tag: 'a',
        targetId: linkTarget,
        name: 'Read more',
        attributes: { href: '#safe-section' },
      }),
    ]);
    const registry = new TargetRegistry();
    registry.replaceObservation(V3_TAB_ID, page.observationId, [registryRecord(linkTarget, 102)]);
    const { adapter, counts } = createFakeAdapter();
    const runtime = new RecordingInteractionModelRuntime((context) => ({
      kind: 'interaction',
      proposal: {
        kind: 'click',
        targetId: findNodeByName(context, 'Read more').targetId,
      },
    }));
    const { agent, audit } = createInteractiveChain({
      adapter,
      targetRegistry: registry,
      runtime,
      observation: page,
    });

    const result = await agent.interact({ tabId: V3_TAB_ID, instruction: 'Read more' });
    assert.equal(result.kind, 'interaction');
    if (result.kind !== 'interaction') {
      return;
    }
    assert.equal(result.result.status, 'succeeded');
    assert.equal(counts.click, 1);

    const event = lastAudit(audit);
    assert.equal(event.policyOutcome, 'ALLOW_NAVIGATE');
    assert.equal(event.grantedAuthority, 'NAVIGATE');
    assert.equal(event.grantIssued, true);
    assert.equal(event.adapterPrimitiveInvoked, true);
  });

  it('executes ordinary type without leaking typed payload into audit events', async () => {
    const fieldTarget = 'target-display-name';
    const page = observation([
      node({
        role: 'textbox',
        tag: 'input',
        targetId: fieldTarget,
        name: 'Display name',
        states: { editable: true },
        attributes: { type: 'text', autocomplete: 'off' },
      }),
    ]);
    const registry = new TargetRegistry();
    registry.replaceObservation(V3_TAB_ID, page.observationId, [registryRecord(fieldTarget, 103)]);
    const { adapter, counts } = createFakeAdapter();
    const runtime = new RecordingInteractionModelRuntime((context) => ({
      kind: 'interaction',
      proposal: {
        kind: 'type',
        targetId: findNodeByName(context, 'Display name').targetId,
        text: V3_TYPED_FIXTURE_VALUE,
      },
    }));
    const { agent, audit } = createInteractiveChain({
      adapter,
      targetRegistry: registry,
      runtime,
      observation: page,
    });

    const result = await agent.interact({ tabId: V3_TAB_ID, instruction: 'Set display name' });
    assert.equal(result.kind, 'interaction');
    if (result.kind !== 'interaction') {
      return;
    }
    assert.equal(result.result.status, 'succeeded');
    assert.equal(counts.type, 1);
    assert.equal(JSON.stringify(audit.getEvents()).includes(V3_TYPED_FIXTURE_VALUE), false);
  });

  it('executes native select using exported option target IDs', async () => {
    const selectTarget = 'target-select';
    const optionBlue = 'target-option-blue';
    const page = observation(nativeSelectNodes(selectTarget, [
      { targetId: 'target-option-red', name: 'Red' },
      { targetId: optionBlue, name: 'Blue' },
      { targetId: 'target-option-green', name: 'Green' },
    ]));
    const registry = new TargetRegistry();
    registry.replaceObservation(V3_TAB_ID, page.observationId, [
      registryRecord(selectTarget, 201),
      registryRecord('target-option-red', 202),
      registryRecord(optionBlue, 203),
      registryRecord('target-option-green', 204),
    ]);
    const { adapter, counts } = createFakeAdapter();
    const runtime = new RecordingInteractionModelRuntime((context) => {
      const option = findNativeOption(context, 'Color', 'Blue');
      return {
        kind: 'interaction',
        proposal: {
          kind: 'select',
          targetId: option.selectTargetId,
          optionTargetId: option.optionTargetId,
        },
      };
    });
    const { agent, audit } = createInteractiveChain({
      adapter,
      targetRegistry: registry,
      runtime,
      observation: page,
    });

    const result = await agent.interact({ tabId: V3_TAB_ID, instruction: 'Choose Blue' });
    assert.equal(result.kind, 'interaction');
    if (result.kind !== 'interaction') {
      return;
    }
    assert.equal(result.result.status, 'succeeded');
    assert.equal(counts.select, 1);

    const event = lastAudit(audit);
    assert.equal(event.policyOutcome, 'ALLOW_INTERACT');
    assert.equal(event.grantIssued, true);
    assert.equal(event.adapterPrimitiveInvoked, true);
  });

  it('authorizes a filtered-catalog option without using catalog position as mechanical authority', async () => {
    const selectTarget = 'target-select';
    const optionA = 'target-option-a';
    const optionC = 'target-option-c';
    const page = observation([
      node({
        role: 'combobox',
        tag: 'select',
        targetId: selectTarget,
        name: 'Exact color',
        nativeOptions: [
          { targetId: optionA, name: 'Alpha', selected: true },
          { targetId: optionC, name: 'Charlie' },
        ],
      }),
      node({ role: 'option', tag: 'option', targetId: optionA, name: 'Alpha', states: { selected: true } }),
      node({ role: 'option', tag: 'option', targetId: optionC, name: 'Charlie' }),
    ]);
    const registry = new TargetRegistry();
    registry.replaceObservation(V3_TAB_ID, page.observationId, [
      registryRecord(selectTarget, 10),
      registryRecord(optionA, 11),
      registryRecord('target-option-b', 12),
      registryRecord(optionC, 13),
    ]);
    let selectRequest: { optionTarget?: { backendNodeId: number } } | undefined;
    const { adapter, counts } = createFakeAdapter({
      onSelect: (request) => {
        selectRequest = request;
      },
    });
    const runtime = new RecordingInteractionModelRuntime((context) => {
      const option = findNativeOption(context, 'Exact color', 'Charlie');
      assert.equal(
        context.nodes
          .find((node) => node.targetId === option.selectTargetId)
          ?.nativeOptions?.map((entry) => entry.name)
          .join(','),
        'Alpha,Charlie',
      );
      return {
        kind: 'interaction',
        proposal: {
          kind: 'select',
          targetId: option.selectTargetId,
          optionTargetId: option.optionTargetId,
        },
      };
    });
    const { agent, audit } = createInteractiveChain({
      adapter,
      targetRegistry: registry,
      runtime,
      observation: page,
    });

    const result = await agent.interact({ tabId: V3_TAB_ID, instruction: 'Choose Charlie' });
    assert.equal(result.kind, 'interaction');
    if (result.kind !== 'interaction') {
      return;
    }
    assert.equal(result.result.status, 'succeeded');
    assert.equal(counts.select, 1);
    assert.equal(selectRequest?.optionTarget?.backendNodeId, 13);
    assert.equal(selectRequest !== undefined && 'optionCatalogIndex' in selectRequest, false);
    const visibleContext = JSON.stringify(
      parseInteractiveContextFromMessages(runtime.requests[0]!.messages),
    );
    assert.doesNotMatch(visibleContext, /backendNodeId/);
    assert.doesNotMatch(visibleContext, /keyboardDelta/);
    assert.doesNotMatch(visibleContext, /optionCatalogIndex/);

    const event = lastAudit(audit);
    assert.equal(event.policyOutcome, 'ALLOW_INTERACT');
    assert.equal(event.grantIssued, true);
    assert.equal(event.adapterPrimitiveInvoked, true);
  });

  it('executes bounded viewport scroll with NAVIGATE authority', async () => {
    const page = observation([
      node({
        role: 'heading',
        tag: 'h1',
        name: 'V3 Safe Interaction Fixture',
      }),
    ]);
    const registry = new TargetRegistry();
    registry.replaceObservation(V3_TAB_ID, page.observationId, []);
    const { adapter, counts } = createFakeAdapter();
    const runtime = new RecordingInteractionModelRuntime(() => ({
      kind: 'interaction',
      proposal: {
        kind: 'scroll',
        mode: 'viewport',
        direction: 'down',
        amountPx: 240,
      },
    }));
    const { agent, audit } = createInteractiveChain({
      adapter,
      targetRegistry: registry,
      runtime,
      observation: page,
    });

    const result = await agent.interact({ tabId: V3_TAB_ID, instruction: 'Scroll down' });
    assert.equal(result.kind, 'interaction');
    if (result.kind !== 'interaction') {
      return;
    }
    assert.equal(result.result.status, 'succeeded');
    assert.equal(counts.scroll, 1);

    const event = lastAudit(audit);
    assert.equal(event.policyOutcome, 'ALLOW_NAVIGATE');
    assert.equal(event.grantedAuthority, 'NAVIGATE');
    assert.equal(event.grantIssued, true);
    assert.equal(event.adapterPrimitiveInvoked, true);
  });

  it('does not retry adapter primitives after post-action observation failure', async () => {
    const expandTarget = 'target-expand';
    const page = observation([
      node({
        role: 'button',
        tag: 'button',
        targetId: expandTarget,
        name: 'Expand details',
        attributes: { type: 'button' },
      }),
    ]);
    const registry = new TargetRegistry();
    registry.replaceObservation(V3_TAB_ID, page.observationId, [registryRecord(expandTarget, 101)]);
    const { adapter, counts } = createFakeAdapter({ failObserveAfterMutation: true });
    const runtime = new RecordingInteractionModelRuntime((context) => ({
      kind: 'interaction',
      proposal: {
        kind: 'click',
        targetId: findNodeByName(context, 'Expand details').targetId,
      },
    }));
    const { agent } = createInteractiveChain({
      adapter,
      targetRegistry: registry,
      runtime,
      observation: page,
    });

    const result = await agent.interact({ tabId: V3_TAB_ID, instruction: 'Expand details' });
    assert.equal(result.kind, 'interaction');
    if (result.kind !== 'interaction') {
      return;
    }
    assert.equal(result.result.status, 'failed');
    assert.equal(counts.click, 1);
    assert.equal(counts.observePage, 1);
  });

  it('rejects multi-action model output at schema validation', () => {
    assert.throws(() =>
      parseAgentModelOutput({
        kind: 'interaction',
        proposal: { kind: 'click', targetId: 'target-1' },
        extra: 'not-allowed',
      }),
    );
  });

  it('invokes the executor at most once per request', async () => {
    const expandTarget = 'target-expand';
    const page = observation([
      node({
        role: 'button',
        tag: 'button',
        targetId: expandTarget,
        name: 'Expand details',
        attributes: { type: 'button' },
      }),
    ]);
    const registry = new TargetRegistry();
    registry.replaceObservation(V3_TAB_ID, page.observationId, [registryRecord(expandTarget, 101)]);
    const { adapter, counts } = createFakeAdapter();
    const runtime = new RecordingInteractionModelRuntime((context) => ({
      kind: 'interaction',
      proposal: {
        kind: 'click',
        targetId: findNodeByName(context, 'Expand details').targetId,
      },
    }));
    const { agent } = createInteractiveChain({
      adapter,
      targetRegistry: registry,
      runtime,
      observation: page,
    });

    await agent.interact({ tabId: V3_TAB_ID, instruction: 'Expand details' });
    assert.equal(counts.click, 1);
    assert.equal(counts.type, 0);
    assert.equal(counts.select, 0);
  });

  it('routes controller interact mode through the interaction chain to interaction-completed', async () => {
    const expandTarget = 'target-expand';
    const page = observation([
      node({
        role: 'button',
        tag: 'button',
        targetId: expandTarget,
        name: 'Expand details',
        attributes: { type: 'button' },
      }),
    ]);
    const registry = new TargetRegistry();
    registry.replaceObservation(V3_TAB_ID, page.observationId, [registryRecord(expandTarget, 101)]);
    const { adapter } = createFakeAdapter();
    const runtime = new RecordingInteractionModelRuntime((context) => ({
      kind: 'interaction',
      proposal: {
        kind: 'click',
        targetId: findNodeByName(context, 'Expand details').targetId,
      },
    }));
    const { agent } = createInteractiveChain({
      adapter,
      targetRegistry: registry,
      runtime,
      observation: page,
    });
    const events: import('../shared/ai-types').AiAnswerEvent[] = [];
    const controller = new AiRequestController({
      readAgent: {
        answer: async () => {
          throw new Error('read agent not expected');
        },
        cancel: () => false,
        clearConversation: () => {},
        clearAllConversations: () => {},
      },
      interactiveAgent: agent,
      emit: (event) => events.push(event),
    });

    controller.startAsk(V3_TAB_ID, 'Expand details', 'interact');
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(events[0]?.type, 'interaction-started');
    assert.equal(events.some((event) => event.type === 'interaction-completed'), true);
    assert.equal(JSON.stringify(events).includes('targetId'), false);
    assert.equal(JSON.stringify(events).includes('proposal'), false);
  });
});
