import type { TabId } from '../shared/browser-types';
import type { ObservePageOptions, PageObservation } from '../shared/observation-types';

export interface PageObserver {
  observePage(tabId: TabId, options?: ObservePageOptions): Promise<PageObservation>;
}
