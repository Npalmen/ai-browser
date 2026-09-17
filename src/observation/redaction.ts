export interface RedactionInput {
  tag?: string;
  role?: string;
  name?: string;
  value?: string;
  attributes?: Record<string, string>;
}

const SENSITIVE_FIELD_PATTERN = /password|card|cvv|cvc|ssn/i;

const SECRET_AUTOCOMPLETE_VALUES = new Set([
  'cvv',
  'cvc',
  'new-password',
  'current-password',
  'ssn',
]);

export function isSecretCandidate(input: RedactionInput): boolean {
  const type = input.attributes?.type?.toLowerCase();
  if (type === 'password') {
    return true;
  }

  const autocomplete = input.attributes?.autocomplete?.toLowerCase();
  if (autocomplete) {
    if (autocomplete.startsWith('cc-')) {
      return true;
    }
    if (SECRET_AUTOCOMPLETE_VALUES.has(autocomplete)) {
      return true;
    }
  }

  const metadataFields = [
    input.name,
    input.attributes?.name,
    input.attributes?.id,
    input.attributes?.placeholder,
  ];

  for (const field of metadataFields) {
    if (field && SENSITIVE_FIELD_PATTERN.test(field)) {
      return true;
    }
  }

  return false;
}

export interface RedactedValueResult {
  value?: string;
  secret: boolean;
  redacted: boolean;
}

export function redactCandidateValue(input: RedactionInput): RedactedValueResult {
  const secret = isSecretCandidate(input);

  if (!input.value) {
    return { value: undefined, secret, redacted: false };
  }

  if (secret) {
    return { value: undefined, secret: true, redacted: true };
  }

  return { value: input.value, secret: false, redacted: false };
}
