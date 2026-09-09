import type { KinematicGraph, KinematicJoint } from '../../domain/kinematics';
import type { AssetDocument, GeometryDefinition, SceneNode } from '../../domain/model';
import type {
  AssetRef,
  ConnectionHealth,
  DataQuality,
  EstimatedTwinValue,
  ProtocolKind,
  TwinAsset,
  TwinBinding,
  TwinCommand,
  TwinCommandStatus,
  TwinComponent,
  TwinDeltaBatch,
  TwinEvent,
  TwinFidelityContract,
  TwinMaturityLevel,
  TwinMode,
  TwinProject,
  TwinRelationship,
  TwinSignal,
  TwinSignalSample,
  TwinSignalValue,
  TwinStateVector,
  TwinValidationIssue,
} from '../../domain/twin';

const schemaVersion = 'industrial-twin/1.0' as const;

const nowUtc = () => new Date().toISOString();

const id = (prefix: string, value: string) =>
  `${prefix}_${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80)}`;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const hasKinematicGraph = (geometry: GeometryDefinition): geometry is GeometryDefinition & { kinematicGraph: KinematicGraph } =>
  'kinematicGraph' in geometry && Boolean(geometry.kinematicGraph);

const geometryRefFromNode = (node: SceneNode): AssetRef | undefined => {
  const geometry = node.geometry;
  if (geometry.kind === 'imported-model') {
    return {
      kind: 'embedded-data-url',
      uri: geometry.assetName,
      format: geometry.sourceFormat,
      version: geometry.assetDataUrl.slice(0, 64),
    };
  }
  if (geometry.kind === 'serialized-object') {
    return {
      kind: 'project-node',
      uri: geometry.assetName,
      format: 'json',
    };
  }
  return {
    kind: 'project-node',
    uri: node.id,
    format: 'json',
  };
};

const signalPath = (assetName: string, joint: KinematicJoint, suffix: 'actual' | 'desired' | 'simulated') =>
  `plant/cell01/${id('', assetName).replace(/^_/, '')}/joints/${joint.name}/position.${suffix}`;

const defaultQualityPolicy = () => ({
  staleAfterMs: 2000,
  badAfterMs: 10000,
  outOfRangeQuality: 'OUT_OF_RANGE' as DataQuality,
  missingTimestampQuality: 'UNCERTAIN' as DataQuality,
});

const signalDataTypeForJoint = (joint: KinematicJoint): TwinSignal['dataType'] => (joint.type === 'fixed' ? 'enum' : 'float');

const unitForJoint = (joint: KinematicJoint) => (joint.type === 'prismatic' ? 'm' : joint.type === 'fixed' ? undefined : 'rad');

const signalRangeForJoint = (joint: KinematicJoint): TwinSignal['range'] | undefined => {
  if (joint.type === 'fixed') return undefined;
  return {
    min: joint.limits?.lower,
    max: joint.limits?.upper,
  };
};

const buildJointSignals = (asset: TwinAsset, node: SceneNode, graph: KinematicGraph, timestampUtc: string) => {
  const components: TwinComponent[] = [];
  const relationships: TwinRelationship[] = [];
  const signals: TwinSignal[] = [];
  const state: Partial<TwinStateVector> = {
    reportedState: {},
    desiredState: {},
    simulatedState: {},
  };

  graph.parts.forEach((part) => {
    const componentId = id('component', `${asset.id}_${part.id}`);
    components.push({
      id: componentId,
      assetId: asset.id,
      name: part.name,
      componentType: part.static ? 'mechanical-part' : 'mechanical-part',
      sourceId: part.id,
      localFrame: {
        position: part.bounds.center,
      },
      signalIds: [],
      metadata: {
        source: 'kinematicGraph',
        meshObjectIds: part.meshObjectIds,
        static: part.static,
      },
    });
    relationships.push({
      id: id('rel', `${asset.id}_contains_${part.id}`),
      sourceId: asset.id,
      targetId: componentId,
      kind: 'contains',
      metadata: { source: 'kinematicGraph.parts' },
    });
  });

  const componentByPartId = new Map(components.map((component) => [String(component.sourceId), component]));
  graph.joints.forEach((joint) => {
    const componentId = id('component', `${asset.id}_${joint.id}`);
    const actualSignalId = id('signal', `${asset.id}_${joint.id}_actual`);
    const desiredSignalId = id('signal', `${asset.id}_${joint.id}_desired`);
    const simulatedSignalId = id('signal', `${asset.id}_${joint.id}_simulated`);
    const unit = unitForJoint(joint);
    const range = signalRangeForJoint(joint);

    components.push({
      id: componentId,
      assetId: asset.id,
      name: joint.name,
      componentType: 'joint',
      sourceId: joint.id,
      localFrame: {
        position: joint.origin.position,
        axis: joint.axis,
      },
      signalIds: [actualSignalId, desiredSignalId, simulatedSignalId],
      metadata: {
        jointType: joint.type,
        source: 'kinematicGraph.joints',
      },
    });

    signals.push(
      {
        id: actualSignalId,
        path: signalPath(node.name, joint, 'actual'),
        dataType: signalDataTypeForJoint(joint),
        unit,
        access: 'read',
        range,
        qualityPolicy: defaultQualityPolicy(),
        metadata: { assetId: asset.id, jointId: joint.id, stateKind: 'reported' },
      },
      {
        id: desiredSignalId,
        path: signalPath(node.name, joint, 'desired'),
        dataType: signalDataTypeForJoint(joint),
        unit,
        access: 'write',
        range,
        qualityPolicy: defaultQualityPolicy(),
        metadata: { assetId: asset.id, jointId: joint.id, stateKind: 'desired' },
      },
      {
        id: simulatedSignalId,
        path: signalPath(node.name, joint, 'simulated'),
        dataType: signalDataTypeForJoint(joint),
        unit,
        access: 'read',
        range,
        qualityPolicy: { ...defaultQualityPolicy(), missingTimestampQuality: 'SIMULATED' },
        metadata: { assetId: asset.id, jointId: joint.id, stateKind: 'simulated' },
      },
    );

    const home = 0;
    state.reportedState![actualSignalId] = makeSample(actualSignalId, home, 'STALE', 0, timestampUtc, undefined, { source: 'initial-empty-reported-state' });
    state.desiredState![desiredSignalId] = makeSample(desiredSignalId, home, 'GOOD', 0, timestampUtc, timestampUtc, { source: 'initial-desired-home' });
    state.simulatedState![simulatedSignalId] = makeSample(simulatedSignalId, home, 'SIMULATED', 0, timestampUtc, timestampUtc, { source: 'initial-simulation-home' });

    const parent = componentByPartId.get(joint.parentPartId);
    const child = componentByPartId.get(joint.childPartId);
    if (parent) {
      relationships.push({
        id: id('rel', `${asset.id}_${joint.id}_parent`),
        sourceId: parent.id,
        targetId: componentId,
        kind: 'kinematic-parent',
        metadata: { jointId: joint.id },
      });
    }
    if (child) {
      relationships.push({
        id: id('rel', `${asset.id}_${joint.id}_child`),
        sourceId: componentId,
        targetId: child.id,
        kind: 'drives',
        metadata: { jointId: joint.id },
      });
    }
  });

  return {
    components,
    relationships,
    signals,
    state: state as Pick<TwinStateVector, 'reportedState' | 'desiredState' | 'simulatedState'>,
  };
};

export type CreateTwinProjectOptions = {
  mode?: TwinMode;
  timestampUtc?: string;
  includeSimulatedBindings?: boolean;
};

export const makeSample = (
  signalId: string,
  value: TwinSignalValue,
  quality: DataQuality,
  sequence: number,
  ingestTimestampUtc: string,
  sourceTimestampUtc?: string,
  metadata?: unknown,
): TwinSignalSample => ({
  signalId,
  sequence,
  value,
  quality,
  sourceTimestampUtc,
  ingestTimestampUtc,
  raw: metadata ? { connectionId: 'foundation', protocol: 'sim', metadata } : undefined,
});

export const createTwinProjectFromAssetDocument = (document: AssetDocument, options: CreateTwinProjectOptions = {}): TwinProject => {
  const timestampUtc = options.timestampUtc ?? nowUtc();
  const mode = options.mode ?? 'simulation';
  const assets: TwinAsset[] = [];
  const components: TwinComponent[] = [];
  const relationships: TwinRelationship[] = [];
  const signals: TwinSignal[] = [];
  const bindings: TwinBinding[] = [];
  const state: TwinStateVector = {
    reportedState: {},
    desiredState: {},
    estimatedState: {},
    simulatedState: {},
  };

  document.nodes.forEach((node) => {
    const assetId = id('asset', node.id);
    const graph = hasKinematicGraph(node.geometry) ? node.geometry.kinematicGraph : undefined;
    const asset: TwinAsset = {
      id: assetId,
      modelId: node.id,
      name: node.name,
      geometryRef: geometryRefFromNode(node),
      kinematicGraphRef: graph ? `${node.id}/kinematicGraph` : undefined,
      componentIds: [],
      signalIds: [],
      relationshipIds: [],
      metadata: {
        sourceNodeId: node.id,
        visible: node.visible,
        locked: node.locked,
        transform: clone(node.transform),
      },
      schemaVersion,
    };
    assets.push(asset);

    if (graph) {
      const generated = buildJointSignals(asset, node, graph, timestampUtc);
      components.push(...generated.components);
      relationships.push(...generated.relationships);
      signals.push(...generated.signals);
      Object.assign(state.reportedState, generated.state.reportedState);
      Object.assign(state.desiredState, generated.state.desiredState);
      Object.assign(state.simulatedState, generated.state.simulatedState);
      if (options.includeSimulatedBindings) {
        generated.signals
          .filter((signal) => signal.metadata.stateKind === 'simulated')
          .forEach((signal) => {
            bindings.push({
              id: id('binding', `${signal.id}_sim`),
              signalId: signal.id,
              connectionId: 'simulation',
              protocol: 'sim',
              mapping: { kind: 'sim', source: 'kinematic-state' },
              enabled: true,
              metadata: { source: 'P0 foundation' },
            });
          });
      }
    }
  });

  assets.forEach((asset) => {
    asset.componentIds = components.filter((component) => component.assetId === asset.id).map((component) => component.id);
    asset.signalIds = signals.filter((signal) => signal.metadata.assetId === asset.id).map((signal) => signal.id);
    asset.relationshipIds = relationships.filter((relationship) => relationship.sourceId === asset.id || asset.componentIds.includes(relationship.sourceId)).map((relationship) => relationship.id);
  });

  const project: TwinProject = {
    schemaVersion,
    id: id('twin', document.metadata.id),
    name: `${document.metadata.name} Twin`,
    mode,
    assets,
    components,
    relationships,
    signals,
    bindings,
    state,
    connectionHealth: options.includeSimulatedBindings
      ? [
          {
            connectionId: 'simulation',
            protocol: 'sim',
            state: 'ONLINE',
            quality: 'SIMULATED',
            updatedAtUtc: timestampUtc,
            message: 'Local simulation source',
          },
        ]
      : [],
    events: [
      {
        id: id('event', `${document.metadata.id}_created_${timestampUtc}`),
        type: 'mode-change',
        severity: 'info',
        timestampUtc,
        message: `Twin project initialized in ${mode} mode.`,
        metadata: { source: 'P0 foundation' },
      },
    ],
    commands: [],
    fidelityContracts: [],
    metadata: {
      createdAtUtc: timestampUtc,
      updatedAtUtc: timestampUtc,
      sourceDocumentId: document.metadata.id,
      maturityLevel: 0,
      references: ['Manual_Tecnico_Cientifico_3D_Asset_Platform_V2_Digital_Twin.pdf P0'],
    },
  };
  project.metadata.maturityLevel = calculateTwinMaturity(project);
  return project;
};

export const calculateTwinMaturity = (project: TwinProject): TwinMaturityLevel => {
  const hasAssets = project.assets.length > 0;
  const hasAutomaticReadBinding = project.signals.some((signal) => signal.access === 'read' && Boolean(signal.bindingId)) || project.bindings.some((binding) => binding.enabled && binding.protocol !== 'sim');
  const hasTimestampedGoodReportedState = Object.values(project.state.reportedState).some((sample) => sample.quality === 'GOOD' && Boolean(sample.ingestTimestampUtc));
  const hasConfirmedCommand = project.commands.some((command) => command.status === 'CONFIRMED');
  const hasBehavioralContract = project.fidelityContracts.some((contract) => contract.mode === 'simulation' && Boolean(contract.metrics.trackingError ?? contract.validationDatasetId));
  const hasPredictiveContract = project.fidelityContracts.some((contract) => Boolean(contract.validationDatasetId) && contract.metrics.replayDeterministic === true);
  if (hasPredictiveContract) return 5;
  if (hasBehavioralContract) return 4;
  if (hasConfirmedCommand) return 3;
  if (hasAutomaticReadBinding && hasTimestampedGoodReportedState) return 2;
  if (hasAutomaticReadBinding) return 1;
  return hasAssets ? 0 : 0;
};

export const applyReportedSamples = (project: TwinProject, samples: TwinSignalSample[], emittedAtUtc = nowUtc()): TwinProject => {
  const next = clone(project);
  samples.forEach((sample) => {
    next.state.reportedState[sample.signalId] = clone(sample);
  });
  next.events.push(
    ...samples
      .filter((sample) => sample.quality !== 'GOOD')
      .map((sample) => ({
        id: id('event', `${sample.signalId}_${sample.sequence}_${sample.quality}`),
        type: 'quality-change' as const,
        severity: sample.quality === 'STALE' || sample.quality === 'UNCERTAIN' || sample.quality === 'SIMULATED' ? ('warning' as const) : ('error' as const),
        timestampUtc: emittedAtUtc,
        message: `${sample.signalId} quality is ${sample.quality}.`,
        relatedSignalId: sample.signalId,
        metadata: { sequence: sample.sequence },
      })),
  );
  next.metadata.updatedAtUtc = emittedAtUtc;
  next.metadata.maturityLevel = calculateTwinMaturity(next);
  return next;
};

export const setDesiredValue = (project: TwinProject, signalId: string, value: TwinSignalValue, requestedAtUtc = nowUtc()): TwinProject => {
  const next = clone(project);
  next.state.desiredState[signalId] = makeSample(signalId, value, 'GOOD', Date.now(), requestedAtUtc, requestedAtUtc, { source: 'desired-state' });
  next.metadata.updatedAtUtc = requestedAtUtc;
  return next;
};

export const setEstimatedValue = (project: TwinProject, signalId: string, value: EstimatedTwinValue): TwinProject => {
  const next = clone(project);
  next.state.estimatedState[signalId] = clone(value);
  next.metadata.updatedAtUtc = value.updatedAtUtc;
  return next;
};

export const setSimulatedValue = (project: TwinProject, signalId: string, value: TwinSignalValue, simulatedAtUtc = nowUtc()): TwinProject => {
  const next = clone(project);
  next.state.simulatedState[signalId] = makeSample(signalId, value, 'SIMULATED', Date.now(), simulatedAtUtc, simulatedAtUtc, { source: 'simulated-state' });
  next.metadata.updatedAtUtc = simulatedAtUtc;
  return next;
};

export const markStaleSamples = (project: TwinProject, atUtc = nowUtc()): TwinProject => {
  const next = clone(project);
  const at = Date.parse(atUtc);
  next.signals.forEach((signal) => {
    const sample = next.state.reportedState[signal.id];
    if (!sample || sample.quality === 'COMM_LOST' || sample.quality === 'BAD') return;
    const reference = Date.parse(sample.sourceTimestampUtc ?? sample.ingestTimestampUtc);
    if (!Number.isFinite(reference)) return;
    const age = at - reference;
    if (age > signal.qualityPolicy.staleAfterMs) {
      next.state.reportedState[signal.id] = {
        ...sample,
        quality: 'STALE',
        ingestTimestampUtc: atUtc,
      };
    }
  });
  next.metadata.updatedAtUtc = atUtc;
  return next;
};

export const createTwinDeltaBatch = (
  sequence: number,
  samples: TwinSignalSample[],
  events: TwinEvent[] = [],
  connectionHealth: ConnectionHealth[] = [],
  emittedAtUtc = nowUtc(),
): TwinDeltaBatch => ({
  sequence,
  emittedAtUtc,
  samples,
  events,
  connectionHealth,
});

export const requestTwinCommand = (
  project: TwinProject,
  input: {
    id: string;
    signalId: string;
    value: TwinSignalValue;
    requestedBy: string;
    ttlMs: number;
    requestedAtUtc?: string;
  },
): TwinProject => {
  const requestedAtUtc = input.requestedAtUtc ?? nowUtc();
  const command: TwinCommand = {
    id: input.id,
    signalId: input.signalId,
    requestedValue: clone(input.value),
    status: 'REQUESTED',
    requestedAtUtc,
    expiresAtUtc: new Date(Date.parse(requestedAtUtc) + input.ttlMs).toISOString(),
    requestedBy: input.requestedBy,
    audit: [{ status: 'REQUESTED', atUtc: requestedAtUtc, message: 'Command requested.' }],
  };
  const next = clone(project);
  next.commands.push(command);
  next.metadata.updatedAtUtc = requestedAtUtc;
  return next;
};

export const transitionTwinCommand = (project: TwinProject, commandId: string, status: TwinCommandStatus, message: string, atUtc = nowUtc()): TwinProject => {
  const next = clone(project);
  const command = next.commands.find((item) => item.id === commandId);
  if (!command) return next;
  command.status = status;
  command.audit.push({ status, atUtc, message });
  if (status === 'CONFIRMED') command.confirmation = { confirmedAtUtc: atUtc };
  next.metadata.updatedAtUtc = atUtc;
  next.metadata.maturityLevel = calculateTwinMaturity(next);
  return next;
};

const isIsoDate = (value: string | undefined) => Boolean(value && Number.isFinite(Date.parse(value)));

export const validateTwinProject = (project: TwinProject): TwinValidationIssue[] => {
  const issues: TwinValidationIssue[] = [];
  if (project.schemaVersion !== schemaVersion) {
    issues.push({ severity: 'error', code: 'SCHEMA_VERSION', message: `Unsupported twin schema ${project.schemaVersion}.` });
  }
  if (!['simulation', 'live', 'replay'].includes(project.mode)) {
    issues.push({ severity: 'error', code: 'MODE_INVALID', message: `Invalid twin mode ${project.mode}.` });
  }

  const assetIds = new Set(project.assets.map((asset) => asset.id));
  const signalIds = new Set(project.signals.map((signal) => signal.id));
  const bindingIds = new Set(project.bindings.map((binding) => binding.id));

  project.assets.forEach((asset) => {
    if (asset.schemaVersion !== schemaVersion) {
      issues.push({ severity: 'error', code: 'ASSET_SCHEMA_VERSION', message: `${asset.name} has unsupported schema.`, assetId: asset.id });
    }
    asset.signalIds.forEach((signalId) => {
      if (!signalIds.has(signalId)) issues.push({ severity: 'error', code: 'ASSET_SIGNAL_REF', message: `${asset.name} references missing signal ${signalId}.`, assetId: asset.id, signalId });
    });
  });

  project.components.forEach((component) => {
    if (!assetIds.has(component.assetId)) {
      issues.push({ severity: 'error', code: 'COMPONENT_ASSET_REF', message: `${component.name} references missing asset ${component.assetId}.`, assetId: component.assetId });
    }
  });

  project.signals.forEach((signal) => {
    if (signal.bindingId && !bindingIds.has(signal.bindingId)) {
      issues.push({ severity: 'error', code: 'SIGNAL_BINDING_REF', message: `${signal.path} references missing binding ${signal.bindingId}.`, signalId: signal.id, bindingId: signal.bindingId });
    }
    if (signal.qualityPolicy.staleAfterMs <= 0 || !Number.isFinite(signal.qualityPolicy.staleAfterMs)) {
      issues.push({ severity: 'error', code: 'QUALITY_POLICY_INVALID', message: `${signal.path} has invalid staleAfterMs.`, signalId: signal.id });
    }
    if (signal.range?.min !== undefined && signal.range?.max !== undefined && signal.range.min > signal.range.max) {
      issues.push({ severity: 'error', code: 'SIGNAL_RANGE_INVALID', message: `${signal.path} has inverted range.`, signalId: signal.id });
    }
  });

  project.bindings.forEach((binding) => {
    if (!signalIds.has(binding.signalId)) {
      issues.push({ severity: 'error', code: 'BINDING_SIGNAL_REF', message: `${binding.id} references missing signal ${binding.signalId}.`, bindingId: binding.id, signalId: binding.signalId });
    }
    if (binding.protocol !== binding.mapping.kind) {
      issues.push({ severity: 'error', code: 'BINDING_PROTOCOL_MISMATCH', message: `${binding.id} protocol does not match mapping kind.`, bindingId: binding.id });
    }
  });

  const stateBuckets = [
    ['reportedState', project.state.reportedState],
    ['desiredState', project.state.desiredState],
    ['simulatedState', project.state.simulatedState],
  ] as const;
  stateBuckets.forEach(([bucketName, bucket]) => {
    Object.values(bucket).forEach((sample) => {
      if (!signalIds.has(sample.signalId)) {
        issues.push({ severity: 'error', code: 'STATE_SIGNAL_REF', message: `${bucketName} references missing signal ${sample.signalId}.`, signalId: sample.signalId });
      }
      if (!isIsoDate(sample.ingestTimestampUtc)) {
        issues.push({ severity: 'error', code: 'STATE_INGEST_TIME', message: `${sample.signalId} has invalid ingest timestamp.`, signalId: sample.signalId });
      }
      if (sample.quality === 'GOOD' && !isIsoDate(sample.sourceTimestampUtc)) {
        issues.push({ severity: 'warning', code: 'STATE_SOURCE_TIME_MISSING', message: `${sample.signalId} is GOOD without source timestamp.`, signalId: sample.signalId });
      }
    });
  });

  Object.entries(project.state.estimatedState).forEach(([signalId, value]) => {
    if (!signalIds.has(signalId)) {
      issues.push({ severity: 'error', code: 'ESTIMATED_SIGNAL_REF', message: `Estimated state references missing signal ${signalId}.`, signalId });
    }
    if (!isIsoDate(value.updatedAtUtc) || !value.method) {
      issues.push({ severity: 'error', code: 'ESTIMATED_METADATA', message: `${signalId} estimate lacks method or timestamp.`, signalId });
    }
  });

  project.commands.forEach((command) => {
    if (!signalIds.has(command.signalId)) {
      issues.push({ severity: 'error', code: 'COMMAND_SIGNAL_REF', message: `${command.id} references missing signal ${command.signalId}.`, commandId: command.id, signalId: command.signalId });
    }
    if (project.mode === 'replay' && ['AUTHORIZED', 'DISPATCHED', 'TRANSPORT_ACK'].includes(command.status)) {
      issues.push({ severity: 'error', code: 'REPLAY_COMMAND_ACTIVE', message: `Replay mode cannot dispatch command ${command.id}.`, commandId: command.id });
    }
    if (command.status === 'CONFIRMED' && !command.confirmation?.confirmedAtUtc) {
      issues.push({ severity: 'error', code: 'COMMAND_CONFIRMATION_MISSING', message: `${command.id} is confirmed without confirmation metadata.`, commandId: command.id });
    }
  });

  project.connectionHealth.forEach((health) => {
    if (!isIsoDate(health.updatedAtUtc)) {
      issues.push({ severity: 'error', code: 'CONNECTION_TIME_INVALID', message: `${health.connectionId} has invalid timestamp.` });
    }
  });

  return issues;
};

export const protocolDisplayName = (protocol: ProtocolKind) => {
  if (protocol === 'opcua') return 'OPC UA';
  if (protocol === 'mqtt') return 'MQTT';
  if (protocol === 'modbus') return 'Modbus';
  if (protocol === 'profinet') return 'PROFINET';
  return 'Simulation';
};
