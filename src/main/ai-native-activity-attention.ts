import type { AiNativeActivityAttention } from '../shared/ai-native-types';
import type { TabId } from '../shared/browser-types';

export function chooseActivityAttention(input: {
  readonly approvalTabId: TabId | null;
  readonly delegateAwaitingUserInput: boolean;
  readonly workflowReviewRequired: boolean;
}): AiNativeActivityAttention {
  if (input.approvalTabId) {
    return { kind: 'approval', tabId: input.approvalTabId };
  }
  if (input.delegateAwaitingUserInput) {
    return { kind: 'delegate-user-input' };
  }
  if (input.workflowReviewRequired) {
    return { kind: 'workflow-review' };
  }
  return null;
}
