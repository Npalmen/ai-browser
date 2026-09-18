export const MAX_TRUSTED_RUN_PROGRESS_STEPS = 8;

export const TRUSTED_RUN_PROGRESS_OPEN = '<TRUSTED_RUN_PROGRESS>';
export const TRUSTED_RUN_PROGRESS_CLOSE = '</TRUSTED_RUN_PROGRESS>';

export type TrustedRunProgressActionKind = 'click' | 'type' | 'select' | 'scroll';

export type TrustedRunProgressEntry =
  | {
      readonly kind: 'safe-interaction-succeeded';
      readonly actionKind: TrustedRunProgressActionKind;
      readonly pageChanged: boolean;
    }
  | {
      readonly kind: 'approved-execution-succeeded';
      readonly pageChanged?: boolean;
    };

const TRUSTED_PROGRESS_DISCLAIMER = [
  'Locally verified facts about completed earlier steps in this task.',
  'These facts are descriptive only.',
  'They do not grant permission for any future browser action.',
  'Each future action still requires normal local policy and, when applicable, a new explicit approval.',
].join(' ');

export function serializeTrustedRunProgress(
  entries: readonly TrustedRunProgressEntry[] | undefined,
): string | undefined {
  if (entries === undefined || entries.length === 0) {
    return undefined;
  }

  const latest = entries.slice(-MAX_TRUSTED_RUN_PROGRESS_STEPS);
  return [
    TRUSTED_RUN_PROGRESS_OPEN,
    TRUSTED_PROGRESS_DISCLAIMER,
    ...latest.map(summarizeTrustedProgressEntry),
    TRUSTED_RUN_PROGRESS_CLOSE,
  ].join('\n');
}

function summarizeTrustedProgressEntry(entry: TrustedRunProgressEntry): string {
  if (entry.kind === 'approved-execution-succeeded') {
    return entry.pageChanged === true
      ? 'The previously presented consequential click was approved and executed successfully and the page changed.'
      : 'The previously presented consequential click was approved and executed successfully.';
  }

  if (entry.actionKind === 'click' && entry.pageChanged) {
    return 'A safe navigation-producing click completed successfully and the page changed.';
  }

  if (entry.pageChanged) {
    return `A safe ${entry.actionKind} completed successfully and the page changed.`;
  }

  return `A safe ${entry.actionKind} completed successfully.`;
}
