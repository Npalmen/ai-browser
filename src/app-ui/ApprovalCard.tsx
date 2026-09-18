import type { PendingApprovalView } from '../shared/approval-types';
import type { ApprovalUiStatus } from './approval-ui-state';

export function ApprovalCard(props: {
  approval: PendingApprovalView;
  status: ApprovalUiStatus;
  message?: string;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <section className="approval-card" aria-label="Approval required">
      <h2 className="approval-card-title">{props.approval.title}</h2>
      {props.approval.description ? (
        <p className="approval-card-description">{props.approval.description}</p>
      ) : null}
      {props.approval.origin ? <p className="approval-card-origin">{props.approval.origin}</p> : null}
      <p className="approval-card-category">{categoryLabel(props.approval.category)}</p>
      <p className="approval-card-status">{statusMessage(props.status, props.message)}</p>
      {props.status === 'pending' || props.status === 'deciding' ? (
        <div className="approval-card-actions">
          <button
            type="button"
            className="ai-panel-button ai-panel-button-primary"
            disabled={props.busy}
            onClick={props.onApprove}
          >
            Approve
          </button>
          <button
            type="button"
            className="ai-panel-button"
            disabled={props.busy}
            onClick={props.onReject}
          >
            Reject
          </button>
        </div>
      ) : null}
    </section>
  );
}

function categoryLabel(category: PendingApprovalView['category']): string {
  switch (category) {
    case 'submit':
      return 'Submit';
    case 'send':
      return 'Send';
    case 'purchase':
      return 'Purchase';
    case 'delete':
      return 'Delete';
    case 'publish':
      return 'Publish';
    case 'book':
      return 'Book';
    case 'reserve':
      return 'Reserve';
    case 'account-change':
      return 'Account change';
    default:
      return 'Consequential action';
  }
}

function statusMessage(status: ApprovalUiStatus, message?: string): string {
  if (status === 'unknown') {
    return (
      message ??
      'The action may have been performed, but the final page state could not be confirmed. Do not retry automatically.'
    );
  }
  if (status === 'completed') {
    return 'Action completed.';
  }
  if (status === 'rejected') {
    return 'Action rejected.';
  }
  if (status === 'expired') {
    return 'This approval has expired.';
  }
  if (status === 'stale') {
    return 'The page changed and this approval is no longer valid.';
  }
  if (status === 'failed') {
    return message ?? 'The approved action could not be performed.';
  }
  if (status === 'executing') {
    return 'Performing the approved action…';
  }
  if (status === 'approved' || status === 'deciding') {
    return 'Working…';
  }
  return message ?? 'This action needs your approval.';
}
