import type { ModelErrorCode } from './model-errors';
import type { ModelAlias, ModelCost, ModelUsage, TaskClass } from './model-types';

export const MODEL_REQUEST_LOG_LIMIT = 100;

export interface ModelRequestLogRecord {
  requestId: string;
  startedAt: number;
  alias: ModelAlias;
  resolvedProviderModelId?: string;
  latencyMs?: number;
  usage?: ModelUsage;
  cost?: ModelCost;
  success: boolean;
  errorCode?: ModelErrorCode;
  tabId?: string;
  taskClass?: TaskClass;
  fallbackCount?: number;
}

export class ModelRequestLog {
  private readonly records: ModelRequestLogRecord[] = [];

  constructor(private readonly limit = MODEL_REQUEST_LOG_LIMIT) {}

  append(record: ModelRequestLogRecord): void {
    this.records.push(record);
    if (this.records.length > this.limit) {
      this.records.shift();
    }
  }

  list(): readonly ModelRequestLogRecord[] {
    return this.records;
  }
}

export const modelRequestLog = new ModelRequestLog();
