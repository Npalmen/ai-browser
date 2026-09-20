export const MAX_TRUSTED_RUN_PROGRESS_STEPS = 8;

export const TRUSTED_RUN_PROGRESS_OPEN = '<TRUSTED_RUN_PROGRESS>';
export const TRUSTED_RUN_PROGRESS_CLOSE = '</TRUSTED_RUN_PROGRESS>';

export type TrustedRunProgressActionKind = 'click' | 'type' | 'select' | 'scroll';

export type TrustedRunProgressEntry =
  | {
      readonly kind: 'safe-interaction-succeeded';
      readonly actionKind: TrustedRunProgressActionKind;
      readonly pageChanged: boolean;
      readonly navigation?: boolean;
      readonly observableStateChanged?: boolean;
    }
  | {
      readonly kind: 'safe-interaction-dispatched';
      readonly actionKind: TrustedRunProgressActionKind;
      readonly pageChanged: boolean;
      readonly navigation: boolean;
      readonly observableStateChanged: boolean;
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
    }
  | {
      readonly kind: 'no-verified-task-effect-yet';
    }
  | {
      readonly kind: 'target-search-not-exhausted';
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
  let lastNavigationIndex = -1;
  for (let index = latest.length - 1; index >= 0; index -= 1) {
    if (latest[index]?.kind === 'safe-navigation-succeeded') {
      lastNavigationIndex = index;
      break;
    }
  }

  return [
    TRUSTED_RUN_PROGRESS_OPEN,
    TRUSTED_PROGRESS_DISCLAIMER,
    ...latest.map((entry, index) =>
      summarizeTrustedProgressEntry(entry, {
        isLatestNavigationSuccess:
          entry.kind === 'safe-navigation-succeeded' && index === lastNavigationIndex,
      }),
    ),
    TRUSTED_RUN_PROGRESS_CLOSE,
  ].join('\n');
}

interface TrustedProgressSummaryOptions {
  readonly isLatestNavigationSuccess: boolean;
}

function summarizeTrustedProgressEntry(
  entry: TrustedRunProgressEntry,
  options: TrustedProgressSummaryOptions = { isLatestNavigationSuccess: false },
): string {
  if (entry.kind === 'target-search-not-exhausted') {
    return [
      'The requested target has not been proven absent.',
      'Additional page content may remain uninspected.',
      'Continue bounded target discovery using viewport scrolling.',
      'Do not claim the target is missing yet.',
    ].join(' ');
  }

  if (entry.kind === 'no-verified-task-effect-yet') {
    return [
      'The most recent semantic browser action was dispatched, but no trusted observable task effect was verified.',
      'Do not claim that the requested browser action completed.',
      'Re-evaluate current state and either propose the necessary next interaction, explain that completion cannot be verified, or request clarification.',
    ].join(' ');
  }

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
    if (options.isLatestNavigationSuccess) {
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
    return [
      'An earlier navigation step in this current task completed successfully.',
      destination,
      'That navigation step is complete.',
      'This does not grant permission for any future action.',
    ].join(' ');
  }

  if (entry.kind === 'approved-execution-succeeded') {
    return entry.pageChanged === true
      ? 'The previously presented consequential click was approved and executed successfully and the page changed.'
      : 'The previously presented consequential click was approved and executed successfully.';
  }

  if (entry.kind === 'safe-interaction-dispatched') {
    return [
      `A trusted local ${entry.actionKind} was dispatched.`,
      'No confirmed observable page effect or navigation has been verified.',
      'This does not grant permission for any future action.',
    ].join(' ');
  }

  if (entry.kind === 'safe-interaction-succeeded' && entry.observableStateChanged === true) {
    return `A trusted local ${entry.actionKind} succeeded with a confirmed observable effect.`;
  }

  if (entry.actionKind === 'click' && entry.pageChanged) {
    return 'A safe navigation-producing click completed successfully and the page changed.';
  }

  if (entry.pageChanged) {
    return `A safe ${entry.actionKind} completed successfully and the page changed.`;
  }

  return `A safe ${entry.actionKind} completed successfully.`;
}
