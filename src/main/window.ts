import { BrowserWindow, session } from 'electron';

import { APP_UI_PARTITION } from './sessions';
import { calculateWebsiteViewBounds, CHROME_HEIGHT } from './website-view-bounds';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

export { CHROME_HEIGHT };

let mainWindow: BrowserWindow | null = null;

export function getWebsiteViewBounds(
  window: BrowserWindow,
  rightInsetPx = 0,
): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const [width, height] = window.getContentSize();
  return calculateWebsiteViewBounds(width, height, rightInsetPx);
}

function isTrustedAppNavigation(targetUrl: string, trustedEntryUrl: URL): boolean {
  try {
    const target = new URL(targetUrl);
    return target.origin === trustedEntryUrl.origin;
  } catch {
    return false;
  }
}

function attachAppUiNavigationGuards(window: BrowserWindow, trustedEntryUrl: URL): void {
  const { webContents } = window;

  webContents.on('will-navigate', (event, url) => {
    if (!isTrustedAppNavigation(url, trustedEntryUrl)) {
      console.log(`[window] denied app-ui navigation: ${url}`);
      event.preventDefault();
    }
  });

  webContents.on('will-redirect', (event, url) => {
    if (!isTrustedAppNavigation(url, trustedEntryUrl)) {
      console.log(`[window] denied app-ui redirect: ${url}`);
      event.preventDefault();
    }
  });

  webContents.setWindowOpenHandler(({ url }) => {
    console.log(`[window] denied app-ui window.open: ${url}`);
    return { action: 'deny' };
  });
}

export function createMainWindow(): BrowserWindow {
  const appUiSession = session.fromPartition(APP_UI_PARTITION);
  const trustedEntryUrl = new URL(MAIN_WINDOW_WEBPACK_ENTRY);

  const window = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      session: appUiSession,
    },
  });

  attachAppUiNavigationGuards(window, trustedEntryUrl);

  window.once('ready-to-show', () => {
    window.show();
  });

  void window.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  window.on('closed', () => {
    mainWindow = null;
  });

  mainWindow = window;
  return window;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
