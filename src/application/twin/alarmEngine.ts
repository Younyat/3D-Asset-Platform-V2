import type { DataQuality, TwinEvent, TwinProject, TwinSignalValue } from '../../domain/twin';

export type AlarmPriority = 'low' | 'medium' | 'high' | 'critical';

export type AlarmRule =
  | {
      id: string;
      name: string;
      priority: AlarmPriority;
      kind: 'high' | 'low';
      signalId: string;
      limit: number;
      onDelayMs?: number;
      offDelayMs?: number;
      deadband?: number;
      enabled: boolean;
    }
  | {
      id: string;
      name: string;
      priority: AlarmPriority;
      kind: 'quality';
      signalId: string;
      qualities: DataQuality[];
      onDelayMs?: number;
      offDelayMs?: number;
      enabled: boolean;
    }
  | {
      id: string;
      name: string;
      priority: AlarmPriority;
      kind: 'deviation';
      actualSignalId: string;
      desiredSignalId: string;
      tolerance: number;
      onDelayMs?: number;
      offDelayMs?: number;
      enabled: boolean;
    }
  | {
      id: string;
      name: string;
      priority: AlarmPriority;
      kind: 'state-mismatch';
      commandSignalId: string;
      feedbackSignalId: string;
      expectedPairs: Array<{ command: TwinSignalValue; feedback: TwinSignalValue }>;
      onDelayMs?: number;
      offDelayMs?: number;
      enabled: boolean;
    };

export type AlarmState = 'normal' | 'pending-active' | 'active' | 'pending-clear' | 'acked' | 'shelved' | 'suppressed' | 'cleared';

export type AlarmInstance = {
  instanceId: string;
  ruleId: string;
  state: AlarmState;
  priority: AlarmPriority;
  activatedAtUtc?: string;
  clearedAtUtc?: string;
  acknowledgedAtUtc?: string;
  shelvedUntilUtc?: string;
  pendingSinceUtc?: string;
  lastEvaluationUtc: string;
  message: string;
  payload: Record<string, unknown>;
};

export type AlarmEvaluationResult = {
  instances: AlarmInstance[];
  events: TwinEvent[];
};

const asNumber = (value: TwinSignalValue): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const equalValue = (a: TwinSignalValue, b: TwinSignalValue) => {
  const an = asNumber(a);
  const bn = asNumber(b);
  if (an !== undefined && bn !== undefined) return an === bn;
  return JSON.stringify(a) === JSON.stringify(b);
};

const timeDiff = (aUtc: string, bUtc: string) => Date.parse(aUtc) - Date.parse(bUtc);

const instanceId = (ruleId: string) => `alarm_${ruleId}`;

const eventFromAlarm = (instance: AlarmInstance, type: 'activated' | 'cleared' | 'acked' | 'shelved', timestampUtc: string): TwinEvent => ({
  id: `${instance.instanceId}_${type}_${timestampUtc.replace(/[^0-9]/g, '')}`,
  type: 'alarm',
  severity: instance.priority === 'critical' || instance.priority === 'high' ? 'error' : instance.priority === 'medium' ? 'warning' : 'info',
  timestampUtc,
  message: `${instance.message} ${type}.`,
  metadata: {
    ruleId: instance.ruleId,
    state: instance.state,
    payload: instance.payload,
  },
});

const ruleDelay = (rule: AlarmRule, kind: 'on' | 'off') => (kind === 'on' ? rule.onDelayMs ?? 0 : rule.offDelayMs ?? 0);

const ruleActive = (project: TwinProject, rule: AlarmRule) => {
  if (!rule.enabled) return { active: false, message: `${rule.name} disabled.`, payload: {} };
  if (rule.kind === 'high' || rule.kind === 'low') {
    const sample = project.state.reportedState[rule.signalId];
    const value = sample ? asNumber(sample.value) : undefined;
    if (value === undefined) return { active: false, message: `${rule.name} has no numeric value.`, payload: { signalId: rule.signalId } };
    const limit = rule.limit;
    const deadband = rule.deadband ?? 0;
    const active = rule.kind === 'high' ? value > limit : value < limit;
    const message = `${rule.name}: ${value} ${rule.kind === 'high' ? '>' : '<'} ${limit}`;
    return { active, message, payload: { signalId: rule.signalId, value, limit, deadband } };
  }
  if (rule.kind === 'quality') {
    const sample = project.state.reportedState[rule.signalId];
    const active = Boolean(sample && rule.qualities.includes(sample.quality));
    return { active, message: `${rule.name}: quality ${sample?.quality ?? 'missing'}`, payload: { signalId: rule.signalId, quality: sample?.quality } };
  }
  if (rule.kind === 'deviation') {
    const actual = project.state.reportedState[rule.actualSignalId];
    const desired = project.state.desiredState[rule.desiredSignalId];
    const actualNumber = actual ? asNumber(actual.value) : undefined;
    const desiredNumber = desired ? asNumber(desired.value) : undefined;
    if (actualNumber === undefined || desiredNumber === undefined) {
      return { active: false, message: `${rule.name} lacks numeric actual/desired.`, payload: { actualSignalId: rule.actualSignalId, desiredSignalId: rule.desiredSignalId } };
    }
    const error = Math.abs(actualNumber - desiredNumber);
    return { active: error > rule.tolerance, message: `${rule.name}: deviation ${error}`, payload: { actual: actualNumber, desired: desiredNumber, error, tolerance: rule.tolerance } };
  }
  if (rule.kind === 'state-mismatch') {
    const command = project.state.desiredState[rule.commandSignalId];
    const feedback = project.state.reportedState[rule.feedbackSignalId];
    const pairMatches = Boolean(command && feedback && rule.expectedPairs.some((pair) => equalValue(pair.command, command.value) && equalValue(pair.feedback, feedback.value)));
    return {
      active: Boolean(command && feedback && !pairMatches),
      message: `${rule.name}: command/feedback mismatch`,
      payload: { commandSignalId: rule.commandSignalId, feedbackSignalId: rule.feedbackSignalId, command: command?.value, feedback: feedback?.value },
    };
  }
  return { active: false, message: `${rule.name} has unsupported rule kind.`, payload: { ruleId: rule.id } };
};

export const evaluateAlarmRules = (project: TwinProject, rules: AlarmRule[], previous: AlarmInstance[] = [], atUtc = new Date().toISOString()): AlarmEvaluationResult => {
  const previousByRule = new Map(previous.map((instance) => [instance.ruleId, instance]));
  const instances: AlarmInstance[] = [];
  const events: TwinEvent[] = [];

  rules.forEach((rule) => {
    const prior = previousByRule.get(rule.id);
    const evaluation = ruleActive(project, rule);
    const shelved = prior?.shelvedUntilUtc && Date.parse(prior.shelvedUntilUtc) > Date.parse(atUtc);
    let next: AlarmInstance = {
      instanceId: prior?.instanceId ?? instanceId(rule.id),
      ruleId: rule.id,
      state: shelved ? 'shelved' : prior?.state ?? 'normal',
      priority: rule.priority,
      activatedAtUtc: prior?.activatedAtUtc,
      clearedAtUtc: prior?.clearedAtUtc,
      acknowledgedAtUtc: prior?.acknowledgedAtUtc,
      shelvedUntilUtc: prior?.shelvedUntilUtc,
      pendingSinceUtc: prior?.pendingSinceUtc,
      lastEvaluationUtc: atUtc,
      message: evaluation.message,
      payload: evaluation.payload,
    };

    if (shelved) {
      instances.push(next);
      return;
    }

    if (evaluation.active) {
      if (next.state === 'active' || next.state === 'acked') {
        instances.push(next);
        return;
      }
      const pendingSince = next.pendingSinceUtc ?? atUtc;
      const delayElapsed = timeDiff(atUtc, pendingSince) >= ruleDelay(rule, 'on');
      if (delayElapsed) {
        next = { ...next, state: 'active', activatedAtUtc: next.activatedAtUtc ?? atUtc, pendingSinceUtc: undefined, clearedAtUtc: undefined };
        events.push(eventFromAlarm(next, 'activated', atUtc));
      } else {
        next = { ...next, state: 'pending-active', pendingSinceUtc: pendingSince };
      }
      instances.push(next);
      return;
    }

    if (next.state === 'active' || next.state === 'acked' || next.state === 'pending-clear') {
      const pendingSince = next.state === 'pending-clear' ? next.pendingSinceUtc ?? atUtc : atUtc;
      const delayElapsed = timeDiff(atUtc, pendingSince) >= ruleDelay(rule, 'off');
      if (delayElapsed) {
        next = { ...next, state: 'cleared', clearedAtUtc: atUtc, pendingSinceUtc: undefined };
        events.push(eventFromAlarm(next, 'cleared', atUtc));
      } else {
        next = { ...next, state: 'pending-clear', pendingSinceUtc: pendingSince };
      }
      instances.push(next);
      return;
    }

    instances.push({ ...next, state: 'normal', pendingSinceUtc: undefined });
  });

  return { instances, events };
};

export const acknowledgeAlarm = (instances: AlarmInstance[], instanceIdValue: string, atUtc = new Date().toISOString()) =>
  instances.map((instance) =>
    instance.instanceId === instanceIdValue && instance.state === 'active'
      ? { ...instance, state: 'acked' as const, acknowledgedAtUtc: atUtc, lastEvaluationUtc: atUtc }
      : instance,
  );

export const shelveAlarm = (instances: AlarmInstance[], instanceIdValue: string, untilUtc: string, atUtc = new Date().toISOString()) =>
  instances.map((instance) =>
    instance.instanceId === instanceIdValue
      ? { ...instance, state: 'shelved' as const, shelvedUntilUtc: untilUtc, lastEvaluationUtc: atUtc, pendingSinceUtc: undefined }
      : instance,
  );
