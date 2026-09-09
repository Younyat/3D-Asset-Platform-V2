import type { DataQuality, TwinCommand, TwinEvent, TwinProject, TwinSignalSample, TwinSignalValue } from '../../domain/twin';
import { applyReportedSamples } from './twinFoundation';

export type HistorianRecord =
  | { kind: 'sample'; sourceTimestampUtc: string; ingestTimestampUtc: string; sequence: number; sample: TwinSignalSample }
  | { kind: 'event'; sourceTimestampUtc: string; ingestTimestampUtc: string; sequence: number; event: TwinEvent }
  | { kind: 'command'; sourceTimestampUtc: string; ingestTimestampUtc: string; sequence: number; command: TwinCommand };

export type DownsampleBucket = {
  signalId: string;
  bucketStartUtc: string;
  min: number;
  max: number;
  mean: number;
  count: number;
  worstQuality: DataQuality;
};

export type ReplayFrame = {
  virtualTimeUtc: string;
  sequence: number;
  project: TwinProject;
  record: HistorianRecord;
};

const qualityRank: Record<DataQuality, number> = {
  GOOD: 0,
  SIMULATED: 1,
  UNCERTAIN: 2,
  STALE: 3,
  OUT_OF_RANGE: 4,
  COMM_LOST: 5,
  CONFIG_ERROR: 6,
  BAD: 7,
};

const sampleTime = (sample: TwinSignalSample) => sample.sourceTimestampUtc ?? sample.ingestTimestampUtc;

const recordTime = (record: HistorianRecord) => Date.parse(record.sourceTimestampUtc);

const compareRecords = (a: HistorianRecord, b: HistorianRecord) => {
  const at = recordTime(a);
  const bt = recordTime(b);
  if (at !== bt) return at - bt;
  return a.sequence - b.sequence;
};

const numericValue = (value: TwinSignalValue): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const bucketStart = (timestampUtc: string, bucketMs: number) => {
  const time = Date.parse(timestampUtc);
  if (!Number.isFinite(time)) throw new Error(`Invalid timestamp ${timestampUtc}.`);
  return new Date(Math.floor(time / bucketMs) * bucketMs).toISOString();
};

export class MemoryHistorian {
  private records: HistorianRecord[] = [];

  appendSamples(samples: TwinSignalSample[]) {
    samples.forEach((sample) => {
      this.records.push({
        kind: 'sample',
        sourceTimestampUtc: sampleTime(sample),
        ingestTimestampUtc: sample.ingestTimestampUtc,
        sequence: sample.sequence,
        sample: JSON.parse(JSON.stringify(sample)) as TwinSignalSample,
      });
    });
    this.records.sort(compareRecords);
  }

  appendEvents(events: TwinEvent[], sequenceStart = 0) {
    events.forEach((event, index) => {
      this.records.push({
        kind: 'event',
        sourceTimestampUtc: event.timestampUtc,
        ingestTimestampUtc: event.timestampUtc,
        sequence: sequenceStart + index,
        event: JSON.parse(JSON.stringify(event)) as TwinEvent,
      });
    });
    this.records.sort(compareRecords);
  }

  appendCommands(commands: TwinCommand[], sequenceStart = 0) {
    commands.forEach((command, index) => {
      this.records.push({
        kind: 'command',
        sourceTimestampUtc: command.requestedAtUtc,
        ingestTimestampUtc: command.requestedAtUtc,
        sequence: sequenceStart + index,
        command: JSON.parse(JSON.stringify(command)) as TwinCommand,
      });
    });
    this.records.sort(compareRecords);
  }

  queryWindow(startUtc: string, endUtc: string) {
    const start = Date.parse(startUtc);
    const end = Date.parse(endUtc);
    return this.records.filter((record) => {
      const time = recordTime(record);
      return Number.isFinite(time) && time >= start && time <= end;
    });
  }

  all() {
    return [...this.records];
  }
}

export const downsampleSamples = (samples: TwinSignalSample[], bucketMs: number): DownsampleBucket[] => {
  const buckets = new Map<string, { values: number[]; qualities: DataQuality[]; signalId: string; start: string }>();
  samples.forEach((sample) => {
    const numeric = numericValue(sample.value);
    if (numeric === undefined) return;
    const start = bucketStart(sampleTime(sample), bucketMs);
    const key = `${sample.signalId}|${start}`;
    const bucket = buckets.get(key) ?? { values: [], qualities: [], signalId: sample.signalId, start };
    bucket.values.push(numeric);
    bucket.qualities.push(sample.quality);
    buckets.set(key, bucket);
  });
  return [...buckets.values()].map((bucket) => ({
    signalId: bucket.signalId,
    bucketStartUtc: bucket.start,
    min: Math.min(...bucket.values),
    max: Math.max(...bucket.values),
    mean: bucket.values.reduce((sum, value) => sum + value, 0) / bucket.values.length,
    count: bucket.values.length,
    worstQuality: bucket.qualities.reduce((worst, quality) => (qualityRank[quality] > qualityRank[worst] ? quality : worst), 'GOOD' as DataQuality),
  }));
};

export const replayRecords = (baseProject: TwinProject, records: HistorianRecord[]): ReplayFrame[] => {
  let project: TwinProject = { ...baseProject, mode: 'replay' };
  return [...records].sort(compareRecords).map((record) => {
    if (record.kind === 'sample') {
      project = applyReportedSamples(project, [record.sample], record.ingestTimestampUtc);
    } else if (record.kind === 'event') {
      project = { ...project, events: [...project.events, record.event], metadata: { ...project.metadata, updatedAtUtc: record.ingestTimestampUtc } };
    } else {
      project = { ...project, commands: [...project.commands, record.command], metadata: { ...project.metadata, updatedAtUtc: record.ingestTimestampUtc } };
    }
    return {
      virtualTimeUtc: record.sourceTimestampUtc,
      sequence: record.sequence,
      project,
      record,
    };
  });
};

export const deterministicReplayHash = (frames: ReplayFrame[]) => {
  const payload = JSON.stringify(
    frames.map((frame) => ({
      time: frame.virtualTimeUtc,
      sequence: frame.sequence,
      reported: frame.project.state.reportedState,
      events: frame.project.events.map((event) => [event.id, event.type, event.timestampUtc]),
      commands: frame.project.commands.map((command) => [command.id, command.status, command.requestedAtUtc]),
    })),
  );
  let hash = 2166136261;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const assertReplayHasNoWritableAdapterRecords = (records: HistorianRecord[]) => {
  const bad = records.find((record) => record.kind === 'event' && record.event.type === 'command' && record.event.metadata.adapterWrite === true);
  if (bad) throw new Error(`Replay contains an adapter write marker at ${bad.sourceTimestampUtc}.`);
};
