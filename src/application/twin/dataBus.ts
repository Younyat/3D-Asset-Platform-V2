import type {
  ConnectionHealth,
  DataQuality,
  EngineeringTransform,
  TwinBinding,
  TwinDeltaBatch,
  TwinEvent,
  TwinProject,
  TwinSignal,
  TwinSignalSample,
  TwinSignalValue,
} from '../../domain/twin';
import { applyReportedSamples, createTwinDeltaBatch, makeSample } from './twinFoundation';

export type RawTwinSample = {
  signalId?: string;
  bindingId?: string;
  value: TwinSignalValue;
  quality?: DataQuality;
  sequence: number;
  sourceTimestampUtc?: string;
  ingestTimestampUtc: string;
  sourceClockId?: string;
  raw?: unknown;
};

export type DeadbandPolicy = {
  absolute?: number;
  relative?: number;
  heartbeatMs?: number;
};

export type DataBusRoute = {
  signal: TwinSignal;
  binding?: TwinBinding;
};

export type NormalizedSampleResult = {
  sample?: TwinSignalSample;
  events: TwinEvent[];
  rejected: boolean;
  reason?: string;
};

export type TwinBusSnapshot = {
  project: TwinProject;
  lastBatch?: TwinDeltaBatch;
  emittedSamples: number;
  suppressedSamples: number;
};

const nowUtc = () => new Date().toISOString();

const eventId = (prefix: string, value: string) =>
  `${prefix}_${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80)}_${Math.random().toString(16).slice(2, 8)}`;

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const valueAsNumber = (value: TwinSignalValue): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const sameValue = (a: TwinSignalValue, b: TwinSignalValue) => {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
};

export const findDataBusRoute = (project: TwinProject, raw: Pick<RawTwinSample, 'signalId' | 'bindingId'>): DataBusRoute | undefined => {
  const binding = raw.bindingId ? project.bindings.find((item) => item.id === raw.bindingId) : undefined;
  const signalId = raw.signalId ?? binding?.signalId;
  const signal = signalId ? project.signals.find((item) => item.id === signalId) : undefined;
  if (!signal) return undefined;
  return { signal, binding };
};

export const applyEngineeringTransform = (value: TwinSignalValue, transform?: EngineeringTransform): TwinSignalValue => {
  if (!transform) return value;
  const applyOne = (input: number) => {
    let output = input;
    if (transform.scale !== undefined) output *= transform.scale;
    if (transform.offset !== undefined) output += transform.offset;
    if (transform.clamp?.min !== undefined) output = Math.max(transform.clamp.min, output);
    if (transform.clamp?.max !== undefined) output = Math.min(transform.clamp.max, output);
    return output;
  };
  if (Array.isArray(value)) return value.map(applyOne);
  const numberValue = valueAsNumber(value);
  return numberValue === undefined ? value : applyOne(numberValue);
};

export const invertEngineeringTransform = (value: TwinSignalValue, transform?: EngineeringTransform): TwinSignalValue => {
  if (!transform) return value;
  const invertOne = (input: number) => {
    let output = input;
    if (transform.offset !== undefined) output -= transform.offset;
    if (transform.scale !== undefined && transform.scale !== 0) output /= transform.scale;
    return output;
  };
  if (Array.isArray(value)) return value.map(invertOne);
  const numberValue = valueAsNumber(value);
  return numberValue === undefined ? value : invertOne(numberValue);
};

export const qualityFromSignalRange = (signal: TwinSignal, value: TwinSignalValue, inputQuality: DataQuality = 'GOOD'): DataQuality => {
  if (inputQuality !== 'GOOD') return inputQuality;
  const numeric = valueAsNumber(value);
  if (numeric === undefined || !signal.range) return inputQuality;
  if (signal.range.min !== undefined && numeric < signal.range.min) return signal.qualityPolicy.outOfRangeQuality;
  if (signal.range.max !== undefined && numeric > signal.range.max) return signal.qualityPolicy.outOfRangeQuality;
  return inputQuality;
};

export const normalizeRawSample = (project: TwinProject, raw: RawTwinSample): NormalizedSampleResult => {
  const route = findDataBusRoute(project, raw);
  if (!route) {
    return {
      rejected: true,
      reason: 'Unknown signal or binding.',
      events: [
        {
          id: eventId('event', `unknown_sample_${raw.signalId ?? raw.bindingId ?? 'missing'}`),
          type: 'quality-change',
          severity: 'error',
          timestampUtc: raw.ingestTimestampUtc,
          message: `Dropped sample for unknown signal or binding ${raw.signalId ?? raw.bindingId ?? 'missing'}.`,
          metadata: { raw },
        },
      ],
    };
  }

  const transformed = applyEngineeringTransform(raw.value, route.binding?.transform);
  const quality = qualityFromSignalRange(route.signal, transformed, raw.quality ?? 'GOOD');
  const sample = makeSample(route.signal.id, transformed, quality, raw.sequence, raw.ingestTimestampUtc, raw.sourceTimestampUtc, {
    bindingId: route.binding?.id,
    sourceClockId: raw.sourceClockId,
    raw: raw.raw,
  });

  if (raw.sourceClockId) sample.sourceClockId = raw.sourceClockId;
  return { sample, events: [], rejected: false };
};

export const shouldEmitSample = (previous: TwinSignalSample | undefined, next: TwinSignalSample, policy: DeadbandPolicy = {}) => {
  if (!previous) return true;
  if (previous.quality !== next.quality) return true;
  if (!sameValue(previous.value, next.value)) {
    const previousNumber = valueAsNumber(previous.value);
    const nextNumber = valueAsNumber(next.value);
    if (previousNumber === undefined || nextNumber === undefined) return true;
    const absolute = policy.absolute ?? 0;
    const relative = policy.relative ?? 0;
    const threshold = absolute + relative * Math.abs(previousNumber);
    if (Math.abs(nextNumber - previousNumber) >= threshold) return true;
  }
  if (policy.heartbeatMs !== undefined) {
    const previousTime = Date.parse(previous.ingestTimestampUtc);
    const nextTime = Date.parse(next.ingestTimestampUtc);
    if (Number.isFinite(previousTime) && Number.isFinite(nextTime) && nextTime - previousTime >= policy.heartbeatMs) return true;
  }
  return false;
};

export const normalizeRawSamples = (project: TwinProject, raws: RawTwinSample[], deadband: DeadbandPolicy = {}) => {
  const samples: TwinSignalSample[] = [];
  const events: TwinEvent[] = [];
  let rejected = 0;
  let suppressed = 0;

  raws.forEach((raw) => {
    const normalized = normalizeRawSample(project, raw);
    events.push(...normalized.events);
    if (!normalized.sample) {
      rejected += 1;
      return;
    }
    const previous = project.state.reportedState[normalized.sample.signalId];
    if (shouldEmitSample(previous, normalized.sample, deadband)) {
      samples.push(normalized.sample);
    } else {
      suppressed += 1;
    }
  });

  return { samples, events, rejected, suppressed };
};

export const applyDataBusSamples = (
  project: TwinProject,
  raws: RawTwinSample[],
  options: {
    sequence: number;
    emittedAtUtc?: string;
    deadband?: DeadbandPolicy;
    connectionHealth?: ConnectionHealth[];
  },
): { project: TwinProject; batch: TwinDeltaBatch; rejected: number; suppressed: number } => {
  const normalized = normalizeRawSamples(project, raws, options.deadband);
  const emittedAtUtc = options.emittedAtUtc ?? nowUtc();
  const next = applyReportedSamples(project, normalized.samples, emittedAtUtc);
  const batch = createTwinDeltaBatch(options.sequence, normalized.samples, normalized.events, options.connectionHealth ?? [], emittedAtUtc);
  return { project: next, batch, rejected: normalized.rejected, suppressed: normalized.suppressed };
};

export class TwinDataBus {
  private project: TwinProject;
  private lastBatch: TwinDeltaBatch | undefined;
  private emittedSamples = 0;
  private suppressedSamples = 0;

  constructor(project: TwinProject) {
    this.project = project;
  }

  ingest(raws: RawTwinSample[], options: { sequence: number; emittedAtUtc?: string; deadband?: DeadbandPolicy; connectionHealth?: ConnectionHealth[] }) {
    const result = applyDataBusSamples(this.project, raws, options);
    this.project = result.project;
    this.lastBatch = result.batch;
    this.emittedSamples += result.batch.samples.length;
    this.suppressedSamples += result.suppressed;
    return result.batch;
  }

  snapshot(): TwinBusSnapshot {
    return {
      project: this.project,
      lastBatch: this.lastBatch,
      emittedSamples: this.emittedSamples,
      suppressedSamples: this.suppressedSamples,
    };
  }
}
