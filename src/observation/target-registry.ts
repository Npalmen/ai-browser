import type {
  DocumentRevision,
  FrameId,
  ObservationId,
  TargetId,
} from '../shared/observation-types';
import type { TabId } from '../shared/browser-types';

export interface TargetRecord {
  targetId: TargetId;
  tabId: TabId;
  observationId: ObservationId;
  documentRevision: DocumentRevision;
  frameId: FrameId;
  backendNodeId: number;
  axNodeId?: string;
}

export class TargetRegistry {
  private readonly targetsByTab = new Map<TabId, Map<TargetId, TargetRecord>>();
  private readonly currentObservationByTab = new Map<TabId, ObservationId>();

  replaceObservation(tabId: TabId, observationId: ObservationId, targets: TargetRecord[]): void {
    const nextTargets = new Map<TargetId, TargetRecord>();
    for (const record of targets) {
      nextTargets.set(record.targetId, record);
    }

    this.targetsByTab.set(tabId, nextTargets);
    this.currentObservationByTab.set(tabId, observationId);
  }

  resolve(tabId: TabId, observationId: ObservationId, targetId: TargetId): TargetRecord | null {
    if (this.currentObservationByTab.get(tabId) !== observationId) {
      return null;
    }

    return this.targetsByTab.get(tabId)?.get(targetId) ?? null;
  }

  getCurrentObservationId(tabId: TabId): ObservationId | null {
    return this.currentObservationByTab.get(tabId) ?? null;
  }

  clearTab(tabId: TabId): void {
    this.targetsByTab.delete(tabId);
    this.currentObservationByTab.delete(tabId);
  }

  clearAll(): void {
    this.targetsByTab.clear();
    this.currentObservationByTab.clear();
  }
}
