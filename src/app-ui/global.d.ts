import type { AiAssistantApi, BrowserShellApi } from '../shared/ipc-contract';

declare global {
  interface Window {
    browserShell: BrowserShellApi;
    aiAssistant: AiAssistantApi;
  }
}

export {};
