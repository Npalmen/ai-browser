import { session } from 'electron';

import { APP_UI_PARTITION, WEBSITE_PARTITION } from './sessions';

export function initializeSecurity(): void {
  initializeWebsiteSession();

  if (process.env.NODE_ENV === 'development') {
    const appUiSession = session.fromPartition(APP_UI_PARTITION);
    const websiteSession = session.fromPartition(WEBSITE_PARTITION);

    console.log(
      `[security] sessions ready: app-ui (in-memory, partition=${APP_UI_PARTITION}), ` +
        `website (persistent, partition=${WEBSITE_PARTITION}, storagePath=${websiteSession.storagePath ?? 'none'})`,
    );
  }
}

function initializeWebsiteSession(): void {
  const websiteSession = session.fromPartition(WEBSITE_PARTITION);

  websiteSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    console.log(`[security] denied permission check: ${permission} from ${requestingOrigin}`);
    return false;
  });

  websiteSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const origin =
      'requestingUrl' in details && details.requestingUrl
        ? details.requestingUrl
        : 'unknown';
    console.log(`[security] denied permission request: ${permission} from ${origin}`);
    callback(false);
  });

  websiteSession.on('will-download', (event, item, webContents) => {
    event.preventDefault();
    const pageUrl = webContents?.getURL() ?? 'unknown';
    console.log(`[security] denied download: ${item.getURL()} (page: ${pageUrl})`);
  });
}
