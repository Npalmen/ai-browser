import type {
  WorkflowDetailView,
  WorkflowGetDetailResult,
  WorkflowGetStateResult,
  WorkflowProductError,
  WorkflowSummaryView,
} from '../shared/workflow-product-types';

export type WorkflowUiScreen = 'list' | 'create' | 'detail';

export interface WorkflowUiState {
  status: 'loading' | 'ready' | 'storage-error' | 'not-initialized';
  workflows: readonly WorkflowSummaryView[];
  selectedWorkflowId: string | null;
  detail: WorkflowDetailView | null;
  detailRequestId: number;
  operationError: string | null;
  mutating: boolean;
  screen: WorkflowUiScreen;
  confirmDelete: boolean;
}

export function emptyWorkflowUiState(): WorkflowUiState {
  return {
    status: 'loading',
    workflows: [],
    selectedWorkflowId: null,
    detail: null,
    detailRequestId: 0,
    operationError: null,
    mutating: false,
    screen: 'list',
    confirmDelete: false,
  };
}

export function applyWorkflowStateResult(
  state: WorkflowUiState,
  result: WorkflowGetStateResult,
): WorkflowUiState {
  if (!result.ok) {
    return {
      ...state,
      operationError: result.error.message,
    };
  }
  const selectedStillPresent =
    state.selectedWorkflowId !== null &&
    result.workflows.some((workflow) => workflow.workflowId === state.selectedWorkflowId);
  return {
    ...state,
    status: result.status === 'storage-error' ? 'storage-error' : result.status === 'ready' ? 'ready' : 'not-initialized',
    workflows: result.workflows,
    selectedWorkflowId: selectedStillPresent ? state.selectedWorkflowId : null,
    detail: selectedStillPresent ? state.detail : null,
    detailRequestId: selectedStillPresent ? state.detailRequestId + 1 : state.detailRequestId,
    screen: selectedStillPresent ? state.screen : 'list',
    confirmDelete: selectedStillPresent ? state.confirmDelete : false,
    operationError: null,
  };
}

export function beginWorkflowCreate(state: WorkflowUiState): WorkflowUiState {
  return {
    ...state,
    screen: 'create',
    selectedWorkflowId: null,
    detail: null,
    confirmDelete: false,
    operationError: null,
  };
}

export function selectWorkflow(state: WorkflowUiState, workflowId: string): WorkflowUiState {
  return {
    ...state,
    screen: 'detail',
    selectedWorkflowId: workflowId,
    detail: state.selectedWorkflowId === workflowId ? state.detail : null,
    detailRequestId: state.detailRequestId + 1,
    confirmDelete: false,
    operationError: null,
  };
}

export function showWorkflowList(state: WorkflowUiState): WorkflowUiState {
  return {
    ...state,
    screen: 'list',
    selectedWorkflowId: null,
    detail: null,
    confirmDelete: false,
    operationError: null,
  };
}

export function applyWorkflowDetailResult(
  state: WorkflowUiState,
  requestId: number,
  result: WorkflowGetDetailResult,
): WorkflowUiState {
  if (requestId !== state.detailRequestId) {
    return state;
  }
  if (!result.ok) {
    return {
      ...state,
      operationError: result.error.message,
    };
  }
  if (state.selectedWorkflowId !== result.workflow.workflowId) {
    return state;
  }
  return {
    ...state,
    detail: result.workflow,
    operationError: null,
  };
}

export function beginWorkflowMutation(state: WorkflowUiState): WorkflowUiState {
  return {
    ...state,
    mutating: true,
    operationError: null,
  };
}

export function endWorkflowMutation(state: WorkflowUiState): WorkflowUiState {
  return {
    ...state,
    mutating: false,
  };
}

export function applyWorkflowOperationError(
  state: WorkflowUiState,
  error: WorkflowProductError,
): WorkflowUiState {
  return {
    ...state,
    mutating: false,
    operationError: error.message,
    confirmDelete: false,
  };
}

export function setWorkflowConfirmDelete(state: WorkflowUiState, confirmDelete: boolean): WorkflowUiState {
  return {
    ...state,
    confirmDelete,
  };
}

export function workflowStorageLocked(state: WorkflowUiState): boolean {
  return state.status !== 'ready';
}
