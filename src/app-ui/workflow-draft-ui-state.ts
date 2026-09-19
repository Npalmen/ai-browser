import type { WorkflowDraft } from '../shared/ai-native-types';
import type {
  WorkflowCreateInput,
  WorkflowDetailView,
  WorkflowProductTrigger,
} from '../shared/workflow-product-types';

export type WorkflowFormTriggerKind = 'manual' | 'one-time' | 'daily' | 'weekly';

export interface WorkflowFormState {
  name: string;
  objective: string;
  url: string;
  triggerKind: WorkflowFormTriggerKind;
  runAtLocal: string;
  timeZone: string;
  hour: string;
  minute: string;
  daysOfWeek: number[];
  enabled: boolean;
}

export function defaultWorkflowFormTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function emptyWorkflowForm(enabled = true): WorkflowFormState {
  return {
    name: '',
    objective: '',
    url: '',
    triggerKind: 'manual',
    runAtLocal: '',
    timeZone: defaultWorkflowFormTimeZone(),
    hour: '9',
    minute: '0',
    daysOfWeek: [1],
    enabled,
  };
}

export function workflowFormFromAiDraft(draft: WorkflowDraft): WorkflowFormState {
  const base = emptyWorkflowForm(false);
  base.name = draft.name;
  base.objective = draft.objective;
  base.url = draft.entryPoint.url;
  const trigger = draft.trigger;
  if (trigger.kind === 'manual') {
    return { ...base, triggerKind: 'manual', enabled: false };
  }
  if (trigger.schedule.kind === 'one-time') {
    return {
      ...base,
      triggerKind: 'one-time',
      runAtLocal: utcIsoToLocalDatetime(trigger.schedule.runAtUtc),
      enabled: false,
    };
  }
  if (trigger.schedule.kind === 'recurring-daily') {
    return {
      ...base,
      triggerKind: 'daily',
      timeZone: trigger.schedule.timeZone,
      hour: String(trigger.schedule.hour),
      minute: String(trigger.schedule.minute),
      enabled: false,
    };
  }
  return {
    ...base,
    triggerKind: 'weekly',
    timeZone: trigger.schedule.timeZone,
    hour: String(trigger.schedule.hour),
    minute: String(trigger.schedule.minute),
    daysOfWeek: [...trigger.schedule.daysOfWeek],
    enabled: false,
  };
}

export function workflowFormFromDetail(detail: WorkflowDetailView): WorkflowFormState {
  const trigger = detail.trigger;
  const base = emptyWorkflowForm(detail.enabled);
  base.name = detail.name;
  base.objective = detail.objective;
  base.url = detail.entryPoint.url;
  if (trigger.kind === 'manual') {
    return { ...base, triggerKind: 'manual' };
  }
  if (trigger.schedule.kind === 'one-time') {
    return {
      ...base,
      triggerKind: 'one-time',
      runAtLocal: utcIsoToLocalDatetime(trigger.schedule.runAtUtc),
    };
  }
  if (trigger.schedule.kind === 'recurring-daily') {
    return {
      ...base,
      triggerKind: 'daily',
      timeZone: trigger.schedule.timeZone,
      hour: String(trigger.schedule.hour),
      minute: String(trigger.schedule.minute),
    };
  }
  return {
    ...base,
    triggerKind: 'weekly',
    timeZone: trigger.schedule.timeZone,
    hour: String(trigger.schedule.hour),
    minute: String(trigger.schedule.minute),
    daysOfWeek: [...trigger.schedule.daysOfWeek],
  };
}

function utcIsoToLocalDatetime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function localDatetimeToUtcIso(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}

export function workflowTriggerFromForm(form: WorkflowFormState): WorkflowProductTrigger | undefined {
  if (form.triggerKind === 'manual') {
    return { kind: 'manual' };
  }
  if (form.triggerKind === 'one-time') {
    const runAtUtc = localDatetimeToUtcIso(form.runAtLocal);
    if (!runAtUtc) {
      return undefined;
    }
    return { kind: 'schedule', schedule: { kind: 'one-time', runAtUtc } };
  }
  const hour = Number(form.hour);
  const minute = Number(form.minute);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return undefined;
  }
  if (form.triggerKind === 'daily') {
    return {
      kind: 'schedule',
      schedule: { kind: 'recurring-daily', timeZone: form.timeZone, hour, minute },
    };
  }
  if (form.daysOfWeek.length === 0) {
    return undefined;
  }
  return {
    kind: 'schedule',
    schedule: {
      kind: 'recurring-weekly',
      timeZone: form.timeZone,
      hour,
      minute,
      daysOfWeek: [...form.daysOfWeek].sort((left, right) => left - right),
    },
  };
}

export function workflowCreateInputFromForm(form: WorkflowFormState): WorkflowCreateInput | undefined {
  const trigger = workflowTriggerFromForm(form);
  if (!trigger) {
    return undefined;
  }
  return {
    name: form.name,
    objective: form.objective,
    entryPoint: { kind: 'url', url: form.url },
    trigger,
    enabled: form.enabled,
  };
}
