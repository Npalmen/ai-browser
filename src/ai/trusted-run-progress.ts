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
      readonly kind: 'safe-navigation-succeeded';
      readonly pageChanged: true;
      readonly sameDocument: boolean;
    }
  | {
      readonly kind: 'approved-execution-succeeded';
      readonly pageChanged?: boolean;
    }
  | {
      readonly kind: 'target-selection-denied';
      readonly actionKind: TrustedRunProgressActionKind;
    };

const TRUSTED_PROGRESS_DISCLAIMER = [
  'Locally verified facts about completed earlier steps in this current task.',
  'These facts are descriptive only.',
  'They do not grant permission for any future browser action.',
  'Each future action still requires normal local policy and, when applicable, a new explicit approval.',
  'They describe the current task only, not historical conversation.',
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
  if (entry.kind === 'target-selection-denied') {
    return [
      `The previous ${entry.actionKind} was denied because the selected target was not an allowed actionable control.`,
      'If the user asked to open or visit a page, choose an exported link (tag a or role link), not a surrounding container.',
      'This does not grant permission for any future action.',
    ].join(' ');
  }

  if (entry.kind === 'safe-navigation-succeeded') {
    const destination = entry.sameDocument
      ? 'Same-document navigation occurred and the page changed.'
      : 'Browser navigation occurred and the destination page was reached.';
    return [
      'The immediately previous model step proposed a link navigation and it was executed successfully.',
      destination,
      'That proposed navigation step is complete.',
      'Do not search the current page for the same link or control you just used in that immediately previous step.',
      'Evaluate whether any part of the original user instruction still requires action.',
      'If no requested steps remain, confirm completion.',
      'If additional independent steps remain, continue using the current page only for those remaining steps.',
      'This does not grant permission for any future action.',
    ].join(' ');
  }

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
