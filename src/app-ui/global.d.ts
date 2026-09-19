import type { AiAssistantApi, AiNativeApi, BrowserShellApi, WorkflowsApi } from '../shared/ipc-contract';

declare global {
  interface Window {
    browserShell: BrowserShellApi;
    aiAssistant: AiAssistantApi;
    workflows: WorkflowsApi;
    aiNative: AiNativeApi;
  }
}

export {};
