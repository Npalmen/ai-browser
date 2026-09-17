import type { ObservationBudgetConfig } from './budgets';
import type { ObservationCandidate } from './observation-builder';
import type { NativeSelectOption, TargetId } from '../shared/observation-types';

interface CandidateTargetInfo {
  candidate: ObservationCandidate;
  targetId: TargetId;
  name: string;
  selected?: true;
}

function optionDisplayName(candidate: ObservationCandidate): string | undefined {
  const name = candidate.name?.trim();
  if (name) {
    return name;
  }

  const text = candidate.text?.trim();
  if (text) {
    return text;
  }

  const value = candidate.value?.trim();
  if (value) {
    return value;
  }

  return undefined;
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
  const byBackendId = new Map<number, CandidateTargetInfo>();
  for (const item of emitted) {
    const backendNodeId = item.candidate.targetIdentity?.backendNodeId;
    if (backendNodeId !== undefined) {
      byBackendId.set(backendNodeId, item);
    }
  }

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

      const name = optionDisplayName(optionItem.candidate);
      if (!name) {
        continue;
      }

      const boundedName =
        name.length > budgets.maxTextCharsPerNode ? name.slice(0, budgets.maxTextCharsPerNode) : name;

      const option: NativeSelectOption = {
        targetId: optionItem.targetId,
        name: boundedName,
      };

      if (optionItem.candidate.selected) {
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
