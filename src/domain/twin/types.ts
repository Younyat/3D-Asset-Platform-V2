import type { Vector3Tuple } from '../model';

export type TwinSchemaVersion = 'industrial-twin/1.0';

export type TwinMode = 'simulation' | 'live' | 'replay';

export type DataQuality = 'GOOD' | 'UNCERTAIN' | 'BAD' | 'STALE' | 'COMM_LOST' | 'OUT_OF_RANGE' | 'CONFIG_ERROR' | 'SIMULATED';

export type TwinSignalValue = boolean | number | string | number[];

export type AssetRef = {
  kind: 'embedded-data-url' | 'warehouse-glb' | 'project-node' | 'external-uri';
  uri: string;
  format?: 'glb' | 'fbx' | 'dae' | 'obj' | '3ds' | 'json' | 'unknown';
  version?: string;
};

export type TwinAsset = {
  id: string;
  modelId: string;
  name: string;
  geometryRef?: AssetRef;
  kinematicGraphRef?: string;
  componentIds: string[];
  signalIds: string[];
  relationshipIds: string[];
  metadata: Record<string, unknown>;
  schemaVersion: TwinSchemaVersion;
};

export type TwinComponent = {
  id: string;
  assetId: string;
  name: string;
  componentType: 'mechanical-part' | 'joint' | 'sensor' | 'actuator' | 'controller' | 'connection' | 'generic';
  sourceId?: string;
  localFrame?: {
    position: Vector3Tuple;
    axis?: Vector3Tuple;
  };
  signalIds: string[];
  metadata: Record<string, unknown>;
};

export type TwinRelationship = {
  id: string;
  sourceId: string;
  targetId: string;
  kind: 'contains' | 'drives' | 'measures' | 'controls' | 'connected-to' | 'kinematic-parent' | 'semantic-link';
  metadata: Record<string, unknown>;
};

export type QualityPolicy = {
  staleAfterMs: number;
  badAfterMs?: number;
  outOfRangeQuality: DataQuality;
  missingTimestampQuality: DataQuality;
};

export type ProtocolKind = 'modbus' | 'mqtt' | 'opcua' | 'profinet' | 'sim';

export type ModbusMapping = {
  kind: 'modbus';
  area: 'coil' | 'discrete-input' | 'input-register' | 'holding-register';
  address: number;
  quantity: number;
  dataType: 'bool' | 'i16' | 'u16' | 'i32' | 'u32' | 'f32' | 'f64';
  byteOrder: 'be' | 'le';
  wordOrder?: 'high-low' | 'low-high';
  displayAddress?: string;
};

export type MqttMapping = {
  kind: 'mqtt';
  topic: string;
  payload: 'json' | 'raw' | 'sparkplug-metric';
  valuePath?: string;
  qos?: 0 | 1 | 2;
  retained?: boolean;
};

export type OpcUaMapping = {
  kind: 'opcua';
  nodeId: string;
  browsePath?: string;
  namespaceUri?: string;
};

export type ProfinetMapping = {
  kind: 'profinet';
  deviceId: string;
  moduleId?: string;
  submoduleId?: string;
  channelId?: string;
};

export type SimulationMapping = {
  kind: 'sim';
  source: 'kinematic-state' | 'manual' | 'scripted-clip';
  expression?: string;
};

export type ProtocolMapping = ModbusMapping | MqttMapping | OpcUaMapping | ProfinetMapping | SimulationMapping;

export type EngineeringTransform = {
  scale?: number;
  offset?: number;
  clamp?: {
    min?: number;
    max?: number;
  };
  unitIn?: string;
  unitOut?: string;
};

export type TwinSignal = {
  id: string;
  path: string;
  dataType: 'bool' | 'int' | 'uint' | 'float' | 'double' | 'string' | 'enum' | 'bytes';
  unit?: string;
  access: 'read' | 'write' | 'command';
  range?: {
    min?: number;
    max?: number;
  };
  bindingId?: string;
  qualityPolicy: QualityPolicy;
  metadata: Record<string, unknown>;
};

export type TwinBinding = {
  id: string;
  signalId: string;
  connectionId: string;
  protocol: ProtocolKind;
  mapping: ProtocolMapping;
  transform?: EngineeringTransform;
  enabled: boolean;
  metadata: Record<string, unknown>;
};

export type TwinSignalSample = {
  signalId: string;
  sequence: number;
  value: TwinSignalValue;
  quality: DataQuality;
  sourceTimestampUtc?: string;
  ingestTimestampUtc: string;
  sourceClockId?: string;
  raw?: {
    connectionId: string;
    protocol: ProtocolKind;
    metadata?: unknown;
  };
};

export type EstimatedTwinValue = {
  value: TwinSignalValue;
  uncertainty?: number;
  method: string;
  updatedAtUtc: string;
};

export type TwinStateVector = {
  reportedState: Record<string, TwinSignalSample>;
  desiredState: Record<string, TwinSignalSample>;
  estimatedState: Record<string, EstimatedTwinValue>;
  simulatedState: Record<string, TwinSignalSample>;
};

export type ConnectionHealthState = 'DISCONNECTED' | 'CONNECTING' | 'ONLINE' | 'DEGRADED' | 'RECONNECTING' | 'FAILED';

export type ConnectionHealth = {
  connectionId: string;
  protocol: ProtocolKind;
  state: ConnectionHealthState;
  quality: DataQuality;
  updatedAtUtc: string;
  message?: string;
  metrics?: {
    roundTripMs?: number;
    reconnectCount?: number;
    lastSequence?: number;
  };
};

export type ConnectionHealthDelta = ConnectionHealth;

export type TwinEvent = {
  id: string;
  type: 'quality-change' | 'connection-change' | 'command' | 'alarm' | 'replay-marker' | 'mode-change';
  severity: 'info' | 'warning' | 'error';
  timestampUtc: string;
  message: string;
  relatedSignalId?: string;
  relatedAssetId?: string;
  metadata: Record<string, unknown>;
};

export type TwinDeltaBatch = {
  sequence: number;
  emittedAtUtc: string;
  samples: TwinSignalSample[];
  events: TwinEvent[];
  connectionHealth: ConnectionHealthDelta[];
};

export type TwinCommandStatus = 'REQUESTED' | 'AUTHORIZED' | 'DISPATCHED' | 'TRANSPORT_ACK' | 'CONFIRMED' | 'REJECTED' | 'EXPIRED' | 'FAILED' | 'TIMEOUT';

export type TwinCommand = {
  id: string;
  signalId: string;
  requestedValue: TwinSignalValue;
  status: TwinCommandStatus;
  requestedAtUtc: string;
  expiresAtUtc: string;
  requestedBy: string;
  authorization?: {
    authorizedBy: string;
    authorizedAtUtc: string;
  };
  confirmation?: {
    confirmedAtUtc: string;
    feedbackSignalId?: string;
    feedbackValue?: TwinSignalValue;
  };
  audit: Array<{
    status: TwinCommandStatus;
    atUtc: string;
    message: string;
  }>;
};

export type TwinFidelityContract = {
  id: string;
  assetId: string;
  mode: TwinMode;
  updateRateHz?: number;
  maxStalenessMs?: number;
  validationDatasetId?: string;
  metrics: {
    freshnessP95Ms?: number;
    visualLatencyP95Ms?: number;
    trackingError?: number;
    replayDeterministic?: boolean;
  };
  validatedAtUtc?: string;
  notes: string[];
};

export type TwinMaturityLevel = 0 | 1 | 2 | 3 | 4 | 5;

export type TwinProject = {
  schemaVersion: TwinSchemaVersion;
  id: string;
  name: string;
  mode: TwinMode;
  assets: TwinAsset[];
  components: TwinComponent[];
  relationships: TwinRelationship[];
  signals: TwinSignal[];
  bindings: TwinBinding[];
  state: TwinStateVector;
  connectionHealth: ConnectionHealth[];
  events: TwinEvent[];
  commands: TwinCommand[];
  fidelityContracts: TwinFidelityContract[];
  metadata: {
    createdAtUtc: string;
    updatedAtUtc: string;
    sourceDocumentId?: string;
    maturityLevel: TwinMaturityLevel;
    references: string[];
  };
};

export type TwinValidationIssue = {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  assetId?: string;
  signalId?: string;
  bindingId?: string;
  commandId?: string;
};
