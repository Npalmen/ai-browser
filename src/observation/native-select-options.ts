import type { ObservationBudgetConfig } from './budgets';
import type { ObservationCandidate } from './observation-builder';
import type { NativeSelectOption, TargetId } from '../shared/observation-types';

interface CandidateTargetInfo {
  candidate: ObservationCandidate;
  targetId: TargetId;
  displayName: string;
  selected?: true;
}

function isNativeSelectCandidate(candidate: ObservationCandidate): boolean {
  return candidate.tag === 'select';
}

function isNativeOptionCandidate(candidate: ObservationCandidate): boolean {
  return candidate.tag === 'option' || candidate.role === 'option';
}

export function buildNativeSelectOptionCatalogs(
  emitted: CandidateTargetInfo[],
  budgets: ObservationBudgetConfig,
): Map<TargetId, NativeSelectOption[]> {
  const catalogs = new Map<TargetId, NativeSelectOption[]>();

  for (const selectItem of emitted) {
    if (!isNativeSelectCandidate(selectItem.candidate)) {
      continue;
    }

    const selectBackendNodeId = selectItem.candidate.targetIdentity?.backendNodeId;
    if (selectBackendNodeId === undefined) {
      continue;
    }

    const options: NativeSelectOption[] = [];

    for (const optionItem of emitted) {
      if (!isNativeOptionCandidate(optionItem.candidate)) {
        continue;
      }

      if (optionItem.candidate.parentBackendNodeId !== selectBackendNodeId) {
        continue;
      }

      const displayName = optionItem.displayName.trim();
      if (!displayName) {
        continue;
      }

      const boundedName =
        displayName.length > budgets.maxTextCharsPerNode
          ? displayName.slice(0, budgets.maxTextCharsPerNode)
          : displayName;

      const option: NativeSelectOption = {
        targetId: optionItem.targetId,
        name: boundedName,
      };

      if (optionItem.selected) {
        option.selected = true;
      }

      options.push(option);

      if (options.length >= budgets.maxNativeSelectOptionsPerSelect) {
        break;
      }
    }

    if (options.length > 0) {
      catalogs.set(selectItem.targetId, options);
    }
  }

  return catalogs;
}
