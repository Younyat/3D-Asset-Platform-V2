import type { DataQuality, MqttMapping, TwinBinding, TwinSignalValue } from '../../domain/twin';
import type { RawTwinSample } from './dataBus';

export type MqttPublishPacket = {
  topic: string;
  payload: string | Uint8Array;
  qos?: 0 | 1 | 2;
  retain?: boolean;
  messageId?: string;
  receivedAtUtc: string;
};

export type SparkplugLifecycle = {
  groupId: string;
  edgeNodeId: string;
  deviceId?: string;
  messageType: 'NBIRTH' | 'NDEATH' | 'DBIRTH' | 'DDEATH' | 'NDATA' | 'DDATA' | 'NCMD' | 'DCMD' | 'STATE';
  bdSeq?: number;
  online: boolean;
};

const mqttBindings = (bindings: TwinBinding[]) =>
  bindings.filter((binding): binding is TwinBinding & { mapping: MqttMapping } => binding.enabled && binding.protocol === 'mqtt' && binding.mapping.kind === 'mqtt');

const payloadToText = (payload: string | Uint8Array) => (typeof payload === 'string' ? payload : new TextDecoder().decode(payload));

export const mqttTopicMatches = (filter: string, topic: string) => {
  const filterParts = filter.split('/');
  const topicParts = topic.split('/');
  for (let index = 0; index < filterParts.length; index += 1) {
    const part = filterParts[index];
    const topicPart = topicParts[index];
    if (part === '#') return index === filterParts.length - 1;
    if (part === '+') {
      if (topicPart === undefined) return false;
      continue;
    }
    if (part !== topicPart) return false;
  }
  return filterParts.length === topicParts.length;
};

export const selectJsonValue = (payload: unknown, selector?: string): TwinSignalValue => {
  if (!selector || selector === '$') {
    if (typeof payload === 'string' || typeof payload === 'number' || typeof payload === 'boolean' || Array.isArray(payload)) return payload as TwinSignalValue;
    throw new Error('MQTT JSON payload needs a selector for object values.');
  }
  const parts = selector.replace(/^\$\./, '').split('.').filter(Boolean);
  let cursor: unknown = payload;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object' || !(part in cursor)) throw new Error(`MQTT selector ${selector} did not match payload.`);
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (typeof cursor === 'number' || typeof cursor === 'string' || typeof cursor === 'boolean' || Array.isArray(cursor)) return cursor as TwinSignalValue;
  throw new Error(`MQTT selector ${selector} resolved to a non-scalar value.`);
};

export const decodeMqttPayload = (packet: MqttPublishPacket, mapping: MqttMapping): TwinSignalValue => {
  const text = payloadToText(packet.payload);
  if (mapping.payload === 'raw') return text;
  if (mapping.payload === 'json') return selectJsonValue(JSON.parse(text), mapping.valuePath);
  if (mapping.payload === 'sparkplug-metric') {
    const parsed = JSON.parse(text) as { metrics?: Array<{ name: string; value: TwinSignalValue }> };
    const metricName = mapping.valuePath?.replace(/^\$\./, '') ?? '';
    const metric = parsed.metrics?.find((item) => item.name === metricName);
    if (!metric) throw new Error(`Sparkplug metric ${metricName} was not found.`);
    return metric.value;
  }
  return text;
};

export const sparkplugLifecycleFromPacket = (packet: MqttPublishPacket): SparkplugLifecycle | undefined => {
  const parts = packet.topic.split('/');
  if (parts[0] !== 'spBv1.0' || parts.length < 4) return undefined;
  const [, groupId, messageType, edgeNodeId, deviceId] = parts;
  if (!['NBIRTH', 'NDEATH', 'DBIRTH', 'DDEATH', 'NDATA', 'DDATA', 'NCMD', 'DCMD', 'STATE'].includes(messageType)) return undefined;
  let bdSeq: number | undefined;
  try {
    const parsed = JSON.parse(payloadToText(packet.payload)) as { bdSeq?: number; seq?: number };
    bdSeq = parsed.bdSeq ?? parsed.seq;
  } catch {
    bdSeq = undefined;
  }
  return {
    groupId,
    edgeNodeId,
    deviceId,
    messageType: messageType as SparkplugLifecycle['messageType'],
    bdSeq,
    online: messageType.endsWith('BIRTH') || messageType === 'NDATA' || messageType === 'DDATA' || messageType === 'STATE',
  };
};

export class MqttDuplicateDetector {
  private seen = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs = 120000) {
    this.ttlMs = ttlMs;
  }

  accept(packet: MqttPublishPacket) {
    const key = `${packet.topic}|${packet.messageId ?? payloadToText(packet.payload).slice(0, 160)}`;
    const now = Date.parse(packet.receivedAtUtc);
    for (const [itemKey, timestamp] of this.seen) {
      if (Number.isFinite(now) && now - timestamp > this.ttlMs) this.seen.delete(itemKey);
    }
    if (this.seen.has(key)) return false;
    this.seen.set(key, Number.isFinite(now) ? now : Date.now());
    return true;
  }
}

export const decodeMqttPublish = (
  packet: MqttPublishPacket,
  bindings: TwinBinding[],
  options: { duplicateDetector?: MqttDuplicateDetector; sequenceStart: number },
): { samples: RawTwinSample[]; lifecycle?: SparkplugLifecycle; duplicate: boolean } => {
  const lifecycle = sparkplugLifecycleFromPacket(packet);
  const detector = options.duplicateDetector;
  if (detector && !detector.accept(packet)) return { samples: [], lifecycle, duplicate: true };

  const matched = mqttBindings(bindings).filter((binding) => mqttTopicMatches(binding.mapping.topic, packet.topic));
  const quality: DataQuality = lifecycle && !lifecycle.online ? 'COMM_LOST' : 'GOOD';
  const samples = matched.map((binding, index) => ({
    bindingId: binding.id,
    value: decodeMqttPayload(packet, binding.mapping),
    quality,
    sequence: options.sequenceStart + index,
    ingestTimestampUtc: packet.receivedAtUtc,
    sourceTimestampUtc: packet.receivedAtUtc,
    raw: {
      topic: packet.topic,
      qos: packet.qos,
      retain: packet.retain,
      lifecycle,
    },
  }));
  return { samples, lifecycle, duplicate: false };
};

export const mqttCommandTopicForBinding = (binding: TwinBinding & { mapping: MqttMapping }) => {
  const commandTopic = binding.metadata.commandTopic;
  if (typeof commandTopic === 'string' && commandTopic.trim()) return commandTopic;
  return binding.mapping.topic.replace(/\/actual$|\/state$|\/reported$/, '/setpoint');
};
