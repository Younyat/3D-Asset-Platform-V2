import type { ConnectionHealth, TwinBinding, TwinCommand, TwinProject, TwinSignal, TwinSignalSample, TwinSignalValue } from '../../domain/twin';
import { invertEngineeringTransform } from './dataBus';
import { requestTwinCommand, transitionTwinCommand } from './twinFoundation';

export type TwinActorRole = 'viewer' | 'operator' | 'engineer' | 'admin';

export type CommandPrecondition =
  | { kind: 'mode-is-live' }
  | { kind: 'connection-online'; connectionId: string }
  | { kind: 'feedback-good'; signalId: string; maxAgeMs: number }
  | { kind: 'machine-mode'; signalId: string; allowedValues: TwinSignalValue[] }
  | { kind: 'human-confirmation'; token: string };

export type CommandRequestInput = {
  id: string;
  signalId: string;
  value: TwinSignalValue;
  requestedBy: string;
  role: TwinActorRole;
  ttlMs: number;
  requestedAtUtc: string;
  reason?: string;
  preconditions?: CommandPrecondition[];
  humanConfirmationToken?: string;
};

export type CommandGateResult = {
  allowed: boolean;
  reasons: string[];
  signal?: TwinSignal;
  binding?: TwinBinding;
  encodedValue?: TwinSignalValue;
};

export type FeedbackConfirmationOptions = {
  commandId: string;
  feedbackSignalId: string;
  tolerance: number;
  atUtc: string;
};

const valueAsNumber = (value: TwinSignalValue): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const valuesEqual = (a: TwinSignalValue, b: TwinSignalValue, tolerance = 0) => {
  const an = valueAsNumber(a);
  const bn = valueAsNumber(b);
  if (an !== undefined && bn !== undefined) return Math.abs(an - bn) <= tolerance;
  return JSON.stringify(a) === JSON.stringify(b);
};

const isFreshEnough = (sample: TwinSignalSample | undefined, atUtc: string, maxAgeMs: number) => {
  if (!sample || sample.quality !== 'GOOD') return false;
  const sourceTime = Date.parse(sample.sourceTimestampUtc ?? sample.ingestTimestampUtc);
  const at = Date.parse(atUtc);
  return Number.isFinite(sourceTime) && Number.isFinite(at) && at - sourceTime <= maxAgeMs;
};

const connectionById = (project: TwinProject, connectionId: string, overrideHealth?: ConnectionHealth[]) =>
  (overrideHealth ?? project.connectionHealth).find((item) => item.connectionId === connectionId);

export const evaluateCommandGates = (project: TwinProject, input: CommandRequestInput, overrideHealth?: ConnectionHealth[]): CommandGateResult => {
  const reasons: string[] = [];
  const signal = project.signals.find((item) => item.id === input.signalId);
  const binding = project.bindings.find((item) => item.id === signal?.bindingId || item.signalId === signal?.id);

  if (!signal) reasons.push(`Unknown target signal ${input.signalId}.`);
  if (signal && signal.access !== 'write' && signal.access !== 'command') reasons.push(`${signal.path} is not writable.`);
  if (input.role === 'viewer') reasons.push('Viewer role cannot write.');
  if (project.mode !== 'live') reasons.push(`Commands require live mode; current mode is ${project.mode}.`);
  if (!binding) reasons.push('Writable command has no binding.');
  if (binding && !binding.enabled) reasons.push(`${binding.id} is disabled.`);
  if (binding) {
    const health = connectionById(project, binding.connectionId, overrideHealth);
    if (!health || health.state !== 'ONLINE' || (health.quality !== 'GOOD' && health.quality !== 'SIMULATED')) reasons.push(`${binding.connectionId} is not online with good quality.`);
  }

  const numeric = valueAsNumber(input.value);
  if (signal?.range && numeric !== undefined) {
    if (signal.range.min !== undefined && numeric < signal.range.min) reasons.push(`${signal.path} command is below range.`);
    if (signal.range.max !== undefined && numeric > signal.range.max) reasons.push(`${signal.path} command is above range.`);
  }

  input.preconditions?.forEach((precondition) => {
    if (precondition.kind === 'mode-is-live' && project.mode !== 'live') reasons.push('Precondition failed: project is not live.');
    if (precondition.kind === 'connection-online') {
      const health = connectionById(project, precondition.connectionId, overrideHealth);
      if (!health || health.state !== 'ONLINE') reasons.push(`Precondition failed: ${precondition.connectionId} is not online.`);
    }
    if (precondition.kind === 'feedback-good' && !isFreshEnough(project.state.reportedState[precondition.signalId], input.requestedAtUtc, precondition.maxAgeMs)) {
      reasons.push(`Precondition failed: feedback ${precondition.signalId} is not fresh GOOD.`);
    }
    if (precondition.kind === 'machine-mode') {
      const sample = project.state.reportedState[precondition.signalId];
      if (!sample || !precondition.allowedValues.some((value) => valuesEqual(value, sample.value))) reasons.push(`Precondition failed: machine mode ${precondition.signalId} is not allowed.`);
    }
    if (precondition.kind === 'human-confirmation' && precondition.token !== input.humanConfirmationToken) {
      reasons.push('Precondition failed: human confirmation is missing.');
    }
  });

  return {
    allowed: reasons.length === 0,
    reasons,
    signal,
    binding,
    encodedValue: binding ? invertEngineeringTransform(input.value, binding.transform) : input.value,
  };
};

export const requestGovernedCommand = (project: TwinProject, input: CommandRequestInput, overrideHealth?: ConnectionHealth[]) => {
  const gates = evaluateCommandGates(project, input, overrideHealth);
  let next = requestTwinCommand(project, {
    id: input.id,
    signalId: input.signalId,
    value: input.value,
    requestedBy: input.requestedBy,
    ttlMs: input.ttlMs,
    requestedAtUtc: input.requestedAtUtc,
  });
  const command = next.commands.find((item) => item.id === input.id);
  if (command) {
    command.audit.push({
      status: gates.allowed ? 'AUTHORIZED' : 'REJECTED',
      atUtc: input.requestedAtUtc,
      message: gates.allowed ? `Authorized by ${input.role}.` : gates.reasons.join(' '),
    });
    command.status = gates.allowed ? 'AUTHORIZED' : 'REJECTED';
    if (gates.allowed) command.authorization = { authorizedBy: input.requestedBy, authorizedAtUtc: input.requestedAtUtc };
  }
  return { project: next, gates };
};

export const markCommandTransportAck = (project: TwinProject, commandId: string, receipt: unknown, atUtc: string) => {
  const next = transitionTwinCommand(project, commandId, 'TRANSPORT_ACK', 'Protocol adapter accepted the command.', atUtc);
  const command = next.commands.find((item) => item.id === commandId);
  if (command) command.audit.push({ status: 'TRANSPORT_ACK', atUtc, message: JSON.stringify(receipt).slice(0, 400) });
  return next;
};

export const confirmCommandFromFeedback = (project: TwinProject, options: FeedbackConfirmationOptions) => {
  const command = project.commands.find((item) => item.id === options.commandId);
  if (!command) return { project, confirmed: false, reason: 'Command not found.' };
  const feedback = project.state.reportedState[options.feedbackSignalId];
  if (!feedback) return { project, confirmed: false, reason: 'Feedback sample missing.' };
  if (!valuesEqual(command.requestedValue, feedback.value, options.tolerance)) {
    return { project, confirmed: false, reason: 'Feedback is outside tolerance.' };
  }
  const next = transitionTwinCommand(project, options.commandId, 'CONFIRMED', 'Feedback entered tolerance.', options.atUtc);
  const nextCommand = next.commands.find((item) => item.id === options.commandId);
  if (nextCommand) {
    nextCommand.confirmation = {
      confirmedAtUtc: options.atUtc,
      feedbackSignalId: options.feedbackSignalId,
      feedbackValue: feedback.value,
    };
  }
  return { project: next, confirmed: true };
};

export const expireCommands = (project: TwinProject, atUtc: string) => {
  let next = project;
  const at = Date.parse(atUtc);
  project.commands.forEach((command: TwinCommand) => {
    const expires = Date.parse(command.expiresAtUtc);
    if (['REQUESTED', 'AUTHORIZED', 'DISPATCHED', 'TRANSPORT_ACK'].includes(command.status) && Number.isFinite(expires) && Number.isFinite(at) && at > expires) {
      next = transitionTwinCommand(next, command.id, 'EXPIRED', 'Command TTL expired.', atUtc);
    }
  });
  return next;
};
