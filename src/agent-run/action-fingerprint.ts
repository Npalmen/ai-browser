import { createHash } from 'node:crypto';

import type { DocumentRevision, TargetId } from '../shared/observation-types';

export type ActionFingerprintDirection = 'up' | 'down' | 'left' | 'right';

export type ActionFingerprintInput =
  | {
      readonly kind: 'click';
      readonly documentRevision: DocumentRevision;
      readonly targetId: TargetId;
    }
  | {
      readonly kind: 'type';
      readonly documentRevision: DocumentRevision;
      readonly targetId: TargetId;
      readonly text: string;
    }
  | {
      readonly kind: 'select';
      readonly documentRevision: DocumentRevision;
      readonly targetId: TargetId;
      readonly optionTargetId: TargetId;
    }
  | {
      readonly kind: 'scroll';
      readonly mode: 'viewport';
      readonly documentRevision: DocumentRevision;
      readonly direction: ActionFingerprintDirection;
      readonly amountPx: number;
    }
  | {
      readonly kind: 'scroll';
      readonly mode: 'into-view';
      readonly documentRevision: DocumentRevision;
      readonly targetId: TargetId;
    };

export function fingerprintAction(input: ActionFingerprintInput): string {
  const hash = createHash('sha256');
  hash.update(canonicalFingerprintSource(input), 'utf8');
  return hash.digest('hex');
}

function canonicalFingerprintSource(input: ActionFingerprintInput): string {
  switch (input.kind) {
    case 'click':
      return JSON.stringify(['click', input.documentRevision, input.targetId]);
    case 'type':
      return JSON.stringify(['type', input.documentRevision, input.targetId, input.text]);
    case 'select':
      return JSON.stringify(['select', input.documentRevision, input.targetId, input.optionTargetId]);
    case 'scroll':
      if (input.mode === 'viewport') {
        return JSON.stringify([
          'scroll',
          'viewport',
          input.documentRevision,
          input.direction,
          input.amountPx,
        ]);
      }
      return JSON.stringify(['scroll', 'into-view', input.documentRevision, input.targetId]);
  }
}
