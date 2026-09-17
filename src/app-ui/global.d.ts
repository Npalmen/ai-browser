import type { BrowserShellApi } from '../shared/ipc-contract';

declare global {
  interface Window {
    browserShell: BrowserShellApi;
  }
}

export {};
