import type { TabId } from '../shared/browser-types';

export const V4_TAB_A: TabId = 'v4-tab-a';
export const V4_TAB_B: TabId = 'v4-tab-b';

export const V4_CONSEQUENTIAL_PATH = '/approval/consequential.html';
export const V4_PROMPT_INJECTION_PATH = '/approval/prompt-injection.html';
export const V4_REPLACE_TARGET_PATH = '/approval/replace-target.html';
export const V4_NAVIGATE_ACTION_PATH = '/approval/navigate-action.html';
export const V4_AFTER_PURCHASE_PATH = '/approval/after-purchase.html';
export const V4_SELECT_PATH = '/approval/consequential-select.html';
export const V4_SENSITIVE_PATH = '/interaction/sensitive-fields.html';

export const V4_PROMPT_INJECTION_CANARY = 'V4_APPROVAL_PROMPT_INJECTION_CANARY';
export const V4_PURCHASE_NAVIGATED = 'V4_PURCHASE_NAVIGATED';

export const V4_PASSWORD_SECRET = 'V3_PASSWORD_SECRET_DO_NOT_LEAK';

export const FORBIDDEN_RENDERER_TOKENS = [
  'preparedActionId',
  'targetId',
  'observationId',
  'documentRevision',
  'executionId',
  'ExecuteGrant',
  'backendNodeId',
  'frameId',
  'proposal',
  'authority',
  'CDP',
] as const;

export const FORBIDDEN_AI_EVENT_TOKENS = [
  'approvalId',
  'targetId',
  'preparedActionId',
  'executionId',
  'grant',
] as const;
