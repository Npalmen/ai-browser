import type { ActivityDeepLink, ActivityUiState } from './activity-ui-state';
import { activityRows } from './activity-ui-state';

export function ActivityPopover(props: {
  readonly state: ActivityUiState;
  readonly onSelect: (target: ActivityDeepLink) => void;
}) {
  const rows = activityRows(props.state.summary);
  return (
    <div className="activity-popover" role="dialog" aria-label="Activity">
      {props.state.error ? (
        <p className="activity-popover-status" role="status">
          {props.state.error}
        </p>
      ) : null}
      {!props.state.error && rows.length === 0 ? (
        <p className="activity-popover-empty">No active AI activity</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="activity-list">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={`activity-row ${row.attention ? 'activity-row-attention' : ''}`}
                onClick={() => props.onSelect(row.deepLink)}
              >
                {row.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
