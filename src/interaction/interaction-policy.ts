import type { InteractionErrorCode } from '../shared/interaction-errors';
import type {
  BoundInteractionProposal,
  InteractionPolicyDecision,
  InteractionPolicyDenyDecision,
} from '../shared/interaction-types';
import type { ObservationNode, PageObservation } from '../shared/observation-types';

export interface InteractionPolicyTargetContext {
  node: ObservationNode;
  optionNode?: ObservationNode;
}

export interface ClassifyInteractionInput {
  proposal: BoundInteractionProposal;
  observation: PageObservation;
  target?: InteractionPolicyTargetContext;
}

const CONSEQUENTIAL_PHRASES = [
  'submit',
  'confirm',
  'buy',
  'purchase',
  'checkout',
  'pay',
  'payment',
  'send',
  'publish',
  'post',
  'delete',
  'remove',
  'erase',
  'order',
  'place order',
  'book',
  'reserve',
  'transfer',
  'save changes',
  'update account',
  'change password',
  'login',
  'log in',
  'sign in',
  'logout',
  'sign out',
  'subscribe',
  'unsubscribe',
  'follow',
  'unfollow',
  'like',
  'vote',
  'apply',
  'upload',
  'add to cart',
];

const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
]);

const SENSITIVE_METADATA_PATTERN =
  /password|passcode|otp|pin|cvv|cvc|security code|card number|token|api key|private key/i;

const SUSPICIOUS_HREF_PATH_PATTERN =
  /checkout|payment|pay|purchase|order|account|login|signin|sign-in|register|subscribe|billing/i;

const UNSUPPORTED_HREF_SCHEMES = /^(javascript|data|file|mailto|tel|blob|about):/i;

export function classifyInteraction(input: ClassifyInteractionInput): InteractionPolicyDecision {
  switch (input.proposal.kind) {
    case 'click':
      return classifyClick(input);
    case 'type':
      return classifyType(input);
    case 'select':
      return classifySelect(input);
    case 'scroll':
      return classifyScroll();
  }
}

function classifyClick(input: ClassifyInteractionInput): InteractionPolicyDecision {
  const node = input.target?.node;
  if (!node) {
    return deny('UNSUPPORTED_TARGET');
  }

  const precondition = checkTargetPreconditions(node);
  if (precondition) {
    return precondition;
  }

  if (hasConsequentialSemantics(node)) {
    return deferExecute();
  }

  if (isNavigationTarget(node)) {
    const href = node.attributes?.href?.trim();
    if (!href) {
      return deny('INTERACTION_DENIED');
    }

    if (UNSUPPORTED_HREF_SCHEMES.test(href)) {
      return deny('INTERACTION_DENIED');
    }

    const resolved = resolveNavigationHref(href, input.observation.document.url);
    if (!resolved) {
      return deny('INTERACTION_DENIED');
    }

    if (hasConsequentialText(resolved)) {
      return deferExecute();
    }

    if (SUSPICIOUS_HREF_PATH_PATTERN.test(resolved)) {
      return deferExecute();
    }

    return { outcome: 'ALLOW_NAVIGATE', authority: 'NAVIGATE' };
  }

  if (isBenignLocalClick(node)) {
    return { outcome: 'ALLOW_INTERACT', authority: 'INTERACT' };
  }

  return deny('INTERACTION_DENIED');
}

function classifyType(input: ClassifyInteractionInput): InteractionPolicyDecision {
  const node = input.target?.node;
  if (!node) {
    return deny('UNSUPPORTED_TARGET');
  }

  if (isSensitiveField(node)) {
    return deny('TARGET_SENSITIVE');
  }

  const precondition = checkTargetPreconditions(node);
  if (precondition) {
    return precondition;
  }

  if (!isEditableTextField(node)) {
    return deny('UNSUPPORTED_TARGET');
  }

  return { outcome: 'ALLOW_INTERACT', authority: 'INTERACT' };
}

function classifySelect(input: ClassifyInteractionInput): InteractionPolicyDecision {
  const selectNode = input.target?.node;
  const optionNode = input.target?.optionNode;
  if (!selectNode || !optionNode) {
    return deny('UNSUPPORTED_TARGET');
  }

  const precondition = checkTargetPreconditions(selectNode);
  if (precondition) {
    return precondition;
  }

  if (selectNode.tag !== 'select') {
    return deny('UNSUPPORTED_TARGET');
  }

  if (!selectNode.nativeOptions || selectNode.nativeOptions.length === 0) {
    return deny('UNSUPPORTED_TARGET');
  }

  const optionTargetId = input.proposal.kind === 'select' ? input.proposal.optionTargetId : undefined;
  if (!optionTargetId || !selectNode.nativeOptions.some((option) => option.targetId === optionTargetId)) {
    return deny('UNSUPPORTED_TARGET');
  }

  if (hasConsequentialSemantics(selectNode) || hasConsequentialSemantics(optionNode)) {
    return deferExecute();
  }

  const catalogOption = selectNode.nativeOptions.find((option) => option.targetId === optionTargetId);
  if (catalogOption && hasConsequentialText(catalogOption.name)) {
    return deferExecute();
  }

  return { outcome: 'ALLOW_INTERACT', authority: 'INTERACT' };
}

function classifyScroll(): InteractionPolicyDecision {
  return { outcome: 'ALLOW_NAVIGATE', authority: 'NAVIGATE' };
}

export function hasConsequentialSemantics(node: ObservationNode): boolean {
  const fields = collectPolicyTextFields(node);
  return fields.some((field) => hasConsequentialText(field));
}

export function hasConsequentialText(value: string): boolean {
  const normalized = normalizePolicyText(value);
  if (!normalized) {
    return false;
  }

  for (const phrase of CONSEQUENTIAL_PHRASES) {
    if (containsPhrase(normalized, phrase)) {
      return true;
    }
  }

  return false;
}

export function isSensitiveField(node: ObservationNode): boolean {
  if (node.states?.secret) {
    return true;
  }

  const type = node.attributes?.type?.toLowerCase();
  if (type === 'password' || type === 'hidden') {
    return true;
  }

  const autocomplete = node.attributes?.autocomplete?.toLowerCase();
  if (autocomplete && SENSITIVE_AUTOCOMPLETE.has(autocomplete)) {
    return true;
  }

  const metadataFields = [node.name, node.attributes?.placeholder, node.attributes?.name];
  for (const field of metadataFields) {
    if (field && SENSITIVE_METADATA_PATTERN.test(field)) {
      return true;
    }
  }

  return false;
}

function checkTargetPreconditions(node: ObservationNode): InteractionPolicyDenyDecision | null {
  if (node.states?.disabled) {
    return deny('TARGET_DISABLED');
  }

  if (!node.interactive) {
    return deny('TARGET_NOT_INTERACTIVE');
  }

  if (!node.visible || !node.inViewport) {
    return deny('INTERACTION_DENIED');
  }

  return null;
}

function isNavigationTarget(node: ObservationNode): boolean {
  if (node.tag === 'a') {
    return true;
  }

  const role = node.role.toLowerCase();
  return role === 'link';
}

function isBenignLocalClick(node: ObservationNode): boolean {
  const role = node.role.toLowerCase();
  const type = node.attributes?.type?.toLowerCase();

  if (node.states?.expanded !== undefined) {
    return true;
  }

  if (node.tag === 'button' && type === 'button') {
    return true;
  }

  if (role === 'tab') {
    return true;
  }

  if (role === 'checkbox' || role === 'radio' || role === 'switch') {
    return true;
  }

  if (role === 'button' && type === 'button') {
    return true;
  }

  return false;
}

function isEditableTextField(node: ObservationNode): boolean {
  if (node.states?.editable !== true) {
    return false;
  }

  const role = node.role.toLowerCase();
  if (role === 'textbox' || role === 'searchbox') {
    return true;
  }

  const tag = node.tag?.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const type = node.attributes?.type?.toLowerCase();
    if (!type || type === 'text' || type === 'search' || type === 'email' || type === 'url' || type === 'tel') {
      return true;
    }
  }

  return false;
}

function resolveNavigationHref(href: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(href, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }

    return `${resolved.pathname}${resolved.search}${resolved.hash}`.toLowerCase();
  } catch {
    return null;
  }
}

function collectPolicyTextFields(node: ObservationNode): string[] {
  const fields: string[] = [];
  if (node.name) {
    fields.push(node.name);
  }
  if (node.text) {
    fields.push(node.text);
  }
  if (node.attributes?.type) {
    fields.push(node.attributes.type);
  }
  if (node.attributes?.href) {
    fields.push(node.attributes.href);
  }
  if (node.attributes?.placeholder) {
    fields.push(node.attributes.placeholder);
  }
  return fields;
}

function normalizePolicyText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function containsPhrase(normalizedText: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i');
  return pattern.test(` ${normalizedText} `);
}

function deny(errorCode: InteractionErrorCode): InteractionPolicyDenyDecision {
  return { outcome: 'DENY', errorCode };
}

function deferExecute(): InteractionPolicyDenyDecision {
  return { outcome: 'DEFER_EXECUTE', errorCode: 'DEFERRED_TO_EXECUTE' };
}
