import assert from 'node:assert/strict';

import { READ_ONLY_SYSTEM_PROMPT } from '../ai/system-prompt';
import type { ModelMessage } from '../ai/model-types';
import type { AiAnswerEvent } from '../shared/ai-types';

export function flattenMessageTexts(messages: readonly ModelMessage[]): {
  system: string[];
  user: string[];
  all: string;
  imageCount: number;
} {
  const system: string[] = [];
  const user: string[] = [];
  let imageCount = 0;
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'image') {
        imageCount += 1;
        continue;
      }
      if (message.role === 'system') {
        system.push(part.text);
      } else {
        user.push(part.text);
      }
    }
  }
  return {
    system,
    user,
    all: [...system, ...user].join('\n'),
    imageCount,
  };
}

export function assertSecureModelMessages(
  messages: readonly ModelMessage[],
  input: {
    question: string;
    canary: string;
    secrets: readonly string[];
  },
): void {
  assert.ok(messages.length >= 3);
  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages.at(-2)?.role, 'user');
  assert.equal(messages.at(-1)?.role, 'user');

  const texts = flattenMessageTexts(messages);
  assert.equal(texts.system.length, 1);
  assert.equal(texts.system[0], READ_ONLY_SYSTEM_PROMPT);
  assert.equal(texts.user.includes(input.question), true);

  const pagePayload = texts.user.find((text) => text.includes('<UNTRUSTED_PAGE_CONTENT>'));
  assert.ok(pagePayload);
  assert.match(pagePayload, /^<UNTRUSTED_PAGE_CONTENT>/);
  assert.match(pagePayload, /<\/UNTRUSTED_PAGE_CONTENT>$/);

  for (const systemText of texts.system) {
    assert.equal(systemText.includes(input.canary), false);
    assert.equal(systemText.includes('<UNTRUSTED_PAGE_CONTENT>'), false);
  }
  assert.equal(pagePayload.includes(input.canary), true);

  for (const secret of input.secrets) {
    assert.equal(texts.all.includes(secret), false);
  }

  assert.equal(texts.imageCount, 0);
  assert.equal(texts.all.includes('"type":"image"'), false);

  const forbidden = [
    'observationId',
    'capturedAt',
    'deviceScaleFactor',
    'backendNodeId',
    'axNodeId',
    'sourceAxNodeCount',
    'sourceDomNodeCount',
    'cookie',
    'credentials',
  ];
  for (const token of forbidden) {
    assert.equal(texts.all.toLowerCase().includes(token.toLowerCase()), false, `leaked ${token}`);
  }
}

export function assertRendererSafeEvents(events: readonly AiAnswerEvent[]): void {
  const serialized = JSON.stringify(events);
  const forbidden = [
    'referencedTargets',
    'providerModelId',
    'resolvedProviderModelId',
    'ModelPageContext',
    'PageObservation',
    'observationId',
    'reasoning',
    '"usage"',
    '"cost"',
    'page-standard',
    'google/gemini',
  ];
  for (const token of forbidden) {
    assert.equal(serialized.includes(token), false, `renderer event leaked ${token}`);
  }
}
