import type { AdapterClickRequest } from './interaction-adapter-types';
import type { TabId } from '../shared/browser-types';

/**
 * Trusted main-process marker around the exact click Input.dispatchMouseEvent
 * boundary. Used only to classify website popups that open during that window.
 */
export class AgentInputDispatchScope {
  private readonly active = new Set<TabId>();

  begin(tabId: TabId): void {
    this.active.add(tabId);
  }

  end(tabId: TabId): void {
    this.active.delete(tabId);
  }

  isActive(tabId: TabId): boolean {
    return this.active.has(tabId);
  }
}

export function bindClickDispatchScope(
  scope: AgentInputDispatchScope,
  tabId: TabId,
  request: AdapterClickRequest,
): { readonly request: AdapterClickRequest; readonly finish: () => void } {
  let entered = false;
  return {
    request: {
      ...request,
      onBeforeInputDispatch: () => {
        scope.begin(tabId);
        entered = true;
        request.onBeforeInputDispatch?.();
      },
    },
    finish: () => {
      if (entered) {
        scope.end(tabId);
        entered = false;
      }
    },
  };
}
