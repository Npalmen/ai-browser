export type TabInvalidationReason = 'navigation' | 'tab-close' | 'renderer-crash';

export function isMainFrameNavigationInvalidation(details: {
  isMainFrame?: boolean;
}): boolean {
  return details.isMainFrame === true;
}
