import {
  MAX_APPROVAL_SUMMARY_TEXT_LENGTH,
  type ConsequentialActionCategory,
  type PreparedActionSummary,
} from '../shared/approval-types';
import type { ObservationNode } from '../shared/observation-types';

const CATEGORY_TITLES: Readonly<Record<ConsequentialActionCategory, string>> = {
  submit: 'Submit form',
  send: 'Send',
  purchase: 'Confirm purchase',
  delete: 'Delete',
  publish: 'Publish',
  book: 'Book',
  reserve: 'Reserve',
  'account-change': 'Save account changes',
  'other-consequential': 'Confirm action',
};

export function classifyConsequentialCategory(node: ObservationNode): ConsequentialActionCategory {
  const searchText = collectCategorySearchText(node);
  const normalizedName = normalizeCategoryText(node.name ?? '');

  if (matchesCategory(searchText, ['delete', 'remove', 'erase'])) {
    return 'delete';
  }

  if (
    matchesCategory(searchText, [
      'confirm purchase',
      'place order',
      'checkout',
      'purchase',
      'buy now',
      'buy',
      'pay',
      'payment',
    ])
  ) {
    return 'purchase';
  }

  if (matchesCategory(searchText, ['send'])) {
    return 'send';
  }

  if (matchesCategory(searchText, ['publish', 'post'])) {
    return 'publish';
  }

  if (matchesCategory(searchText, ['book'])) {
    return 'book';
  }

  if (matchesCategory(searchText, ['reserve'])) {
    return 'reserve';
  }

  if (matchesCategory(searchText, ['save changes', 'update account'])) {
    return 'account-change';
  }

  if (
    node.attributes?.type?.toLowerCase() === 'submit' ||
    matchesCategory(searchText, ['submit'])
  ) {
    return 'submit';
  }

  if (normalizedName === 'confirm') {
    return 'other-consequential';
  }

  return 'other-consequential';
}

export function buildPreparedActionSummary(
  category: ConsequentialActionCategory,
  node: ObservationNode,
  documentUrl: string,
): PreparedActionSummary {
  const description = buildSummaryDescription(node);
  const origin = deriveApprovalOrigin(documentUrl);

  return Object.freeze({
    title: CATEGORY_TITLES[category],
    ...(description !== undefined ? { description } : {}),
    ...(origin !== undefined ? { origin } : {}),
  });
}

export function deriveApprovalOrigin(documentUrl: string): string | undefined {
  try {
    const parsed = new URL(documentUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function buildSummaryDescription(node: ObservationNode): string | undefined {
  const raw = node.name?.trim() || node.text?.trim();
  if (!raw) {
    return undefined;
  }

  const normalized = normalizeSummaryText(raw);
  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= MAX_APPROVAL_SUMMARY_TEXT_LENGTH) {
    return normalized;
  }

  return normalized.slice(0, MAX_APPROVAL_SUMMARY_TEXT_LENGTH);
}

function collectCategorySearchText(node: ObservationNode): string {
  const parts: string[] = [];
  if (node.name) {
    parts.push(node.name);
  }
  if (node.text) {
    parts.push(node.text);
  }
  if (node.attributes?.type) {
    parts.push(node.attributes.type);
  }
  if (node.attributes?.href) {
    parts.push(node.attributes.href);
  }
  return normalizeCategoryText(parts.join(' '));
}

function normalizeCategoryText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeSummaryText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function matchesCategory(normalizedText: string, phrases: ReadonlyArray<string>): boolean {
  for (const phrase of phrases) {
    if (containsCategoryPhrase(normalizedText, phrase)) {
      return true;
    }
  }
  return false;
}

function containsCategoryPhrase(normalizedText: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i');
  return pattern.test(` ${normalizedText} `);
}
