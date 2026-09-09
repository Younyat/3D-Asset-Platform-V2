import type { AssetDocument } from '../../domain/model';
import type { KinematicGraph } from '../../domain/kinematics';
import type { TwinBinding, TwinProject } from '../../domain/twin';
import {
  applyReportedSamples,
  calculateTwinMaturity,
  createTwinDeltaBatch,
  createTwinProjectFromAssetDocument,
  makeSample,
  markStaleSamples,
  requestTwinCommand,
  setDesiredValue,
  setEstimatedValue,
  setSimulatedValue,
  transitionTwinCommand,
  validateTwinProject,
} from './twinFoundation';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const deepEqualJson = (a: unknown, b: unknown, message: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(message);
};

const testGraph = (): KinematicGraph => ({
  rootPartId: 'base',
  parts: [
    {
      id: 'base',
      name: 'BASE_fixed',
      meshObjectIds: ['base_mesh'],
      localFrame: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      bounds: { min: [-1, 0, -1], max: [1, 0.4, 1], size: [2, 0.4, 2], center: [0, 0.2, 0] },
      static: true,
      visible: true,
      source: 'imported',
      metadata: {},
    },
    {
      id: 'arm',
      name: 'J1_arm',
      meshObjectIds: ['arm_mesh'],
      localFrame: { position: [0, 0.4, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      bounds: { min: [-0.1, 0.4, -0.1], max: [0.1, 1.2, 0.1], size: [0.2, 0.8, 0.2], center: [0, 0.8, 0] },
      static: false,
      visible: true,
      source: 'imported',
      metadata: {},
    },
  ],
  joints: [
    {
      id: 'j1',
      name: 'J1_base_yaw',
      parentPartId: 'base',
      childPartId: 'arm',
      type: 'revolute',
      origin: { position: [0, 0.4, 0], rotation: [0, 0, 0, 1] },
      axis: [0, 1, 0],
      limits: { lower: -1.57, upper: 1.57, velocity: 1 },
      source: 'manual',
      confidence: 1,
      evidence: [{ type: 'manual', score: 1 }],
      status: 'validated',
    },
  ],
});

const testDocument = (): AssetDocument => ({
  schemaVersion: 1,
  metadata: {
    id: 'project-1',
    name: 'Robot Project',
    author: 'tester',
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  },
  nodes: [
    {
      id: 'robot-1',
      name: 'Robot 01',
      geometry: {
        kind: 'imported-model',
        assetName: 'robot.glb',
        assetDataUrl: 'data:model/gltf-binary;base64,AAAA',
        sourceFormat: 'glb',
        importScale: 1,
        importOffset: [0, 0, 0],
        originalBounds: [1, 1, 1],
        normalizedBounds: [1, 1, 1],
        bones: [],
        animations: [],
        joints: [],
        kinematicGraph: testGraph(),
        kinematicState: { jointValues: { j1: 0 }, homeJointValues: { j1: 0 } },
      },
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      material: { name: 'Steel', color: '#999999', roughness: 0.5, metalness: 0.2 },
      visible: true,
      locked: false,
      createdAt: '2026-09-06T00:00:00.000Z',
    },
  ],
});

const assertValid = (project: TwinProject) => {
  const errors = validateTwinProject(project).filter((issue) => issue.severity === 'error');
  if (errors.length) throw new Error(`Twin project validation failed: ${errors.map((issue) => issue.code).join(', ')}`);
};

const runFoundationCreationTest = () => {
  const document = testDocument();
  const graphBefore = JSON.stringify(document.nodes[0].geometry);
  const project = createTwinProjectFromAssetDocument(document, { timestampUtc: '2026-09-06T12:00:00.000Z', includeSimulatedBindings: true });
  assert(project.schemaVersion === 'industrial-twin/1.0', 'P0 schema version is wrong.');
  assert(project.mode === 'simulation', 'P0 default mode must be simulation.');
  assert(project.assets.length === 1, 'P0 must create one TwinAsset per scene node.');
  assert(project.assets[0].kinematicGraphRef === 'robot-1/kinematicGraph', 'KinematicGraph must be referenced, not duplicated into protocol fields.');
  assert(project.components.some((component) => component.componentType === 'joint'), 'P0 must expose joints as semantic components.');
  assert(project.signals.length === 3, 'P0 must create reported, desired and simulated joint signals.');
  assert(Object.keys(project.state.reportedState).length === 1, 'P0 must initialize reported state separately.');
  assert(Object.keys(project.state.desiredState).length === 1, 'P0 must initialize desired state separately.');
  assert(Object.keys(project.state.simulatedState).length === 1, 'P0 must initialize simulated state separately.');
  deepEqualJson(document.nodes[0].geometry, JSON.parse(graphBefore), 'P0 twin creation mutated the source model geometry.');
  assertValid(project);
};

const runStateSeparationTest = () => {
  const project = createTwinProjectFromAssetDocument(testDocument(), { timestampUtc: '2026-09-06T12:00:00.000Z' });
  const actualSignal = project.signals.find((signal) => signal.metadata.stateKind === 'reported');
  const desiredSignal = project.signals.find((signal) => signal.metadata.stateKind === 'desired');
  const simulatedSignal = project.signals.find((signal) => signal.metadata.stateKind === 'simulated');
  assert(actualSignal && desiredSignal && simulatedSignal, 'P0 test signals were not created.');

  const desired = setDesiredValue(project, desiredSignal.id, 0.8, '2026-09-06T12:00:01.000Z');
  const simulated = setSimulatedValue(desired, simulatedSignal.id, 0.4, '2026-09-06T12:00:02.000Z');
  const reported = applyReportedSamples(simulated, [makeSample(actualSignal.id, 0.2, 'GOOD', 1, '2026-09-06T12:00:03.000Z', '2026-09-06T12:00:03.000Z')], '2026-09-06T12:00:03.000Z');

  assert(reported.state.desiredState[desiredSignal.id].value === 0.8, 'Desired state was overwritten by reported state.');
  assert(reported.state.simulatedState[simulatedSignal.id].value === 0.4, 'Simulated state was overwritten by reported state.');
  assert(reported.state.reportedState[actualSignal.id].value === 0.2, 'Reported state was not updated.');
  assertValid(reported);
};

const runQualityAndStalenessTest = () => {
  const project = createTwinProjectFromAssetDocument(testDocument(), { timestampUtc: '2026-09-06T12:00:00.000Z' });
  const signal = project.signals.find((item) => item.metadata.stateKind === 'reported');
  assert(signal, 'Reported signal missing.');
  const live = applyReportedSamples(project, [makeSample(signal.id, 1, 'GOOD', 10, '2026-09-06T12:00:01.000Z', '2026-09-06T12:00:01.000Z')], '2026-09-06T12:00:01.000Z');
  const stale = markStaleSamples(live, '2026-09-06T12:00:05.500Z');
  assert(stale.state.reportedState[signal.id].quality === 'STALE', 'Stale policy did not mark old live data.');
  assertValid(stale);
};

const runMaturityTest = () => {
  let project = createTwinProjectFromAssetDocument(testDocument(), { timestampUtc: '2026-09-06T12:00:00.000Z' });
  assert(calculateTwinMaturity(project) === 0, 'A disconnected asset must be Digital Model level 0.');
  const signal = project.signals.find((item) => item.metadata.stateKind === 'reported');
  assert(signal, 'Reported signal missing.');
  const binding: TwinBinding = {
    id: 'binding_modbus_j1',
    signalId: signal.id,
    connectionId: 'plc01',
    protocol: 'modbus',
    mapping: { kind: 'modbus', area: 'holding-register', address: 120, quantity: 2, dataType: 'f32', byteOrder: 'be', wordOrder: 'high-low' },
    enabled: true,
    metadata: {},
  };
  project = { ...project, bindings: [binding], signals: project.signals.map((item) => (item.id === signal.id ? { ...item, bindingId: binding.id } : item)) };
  assert(calculateTwinMaturity(project) === 1, 'A bound read signal without current state must be Digital Shadow level 1.');
  project = applyReportedSamples(project, [makeSample(signal.id, 0.35, 'GOOD', 3, '2026-09-06T12:00:02.000Z', '2026-09-06T12:00:02.000Z')], '2026-09-06T12:00:02.000Z');
  assert(calculateTwinMaturity(project) === 2, 'A bound timestamped GOOD reported state must be Operational Twin level 2.');
  assertValid(project);
};

const runCommandGovernanceTest = () => {
  const project = createTwinProjectFromAssetDocument(testDocument(), { mode: 'replay', timestampUtc: '2026-09-06T12:00:00.000Z' });
  const desiredSignal = project.signals.find((signal) => signal.metadata.stateKind === 'desired');
  assert(desiredSignal, 'Desired signal missing.');
  const requested = requestTwinCommand(project, { id: 'cmd-1', signalId: desiredSignal.id, value: 0.5, requestedBy: 'operator', ttlMs: 1000, requestedAtUtc: '2026-09-06T12:00:01.000Z' });
  const dispatchedInReplay = transitionTwinCommand(requested, 'cmd-1', 'DISPATCHED', 'Should be rejected by validation in replay.', '2026-09-06T12:00:01.500Z');
  const issues = validateTwinProject(dispatchedInReplay);
  assert(issues.some((issue) => issue.code === 'REPLAY_COMMAND_ACTIVE'), 'Replay mode must not allow active command dispatch.');
};

const runDeltaBatchTest = () => {
  const batch = createTwinDeltaBatch(7, [makeSample('signal-1', 1, 'GOOD', 7, '2026-09-06T12:00:00.000Z', '2026-09-06T12:00:00.000Z')], [], [], '2026-09-06T12:00:00.010Z');
  assert(batch.sequence === 7, 'TwinDeltaBatch sequence mismatch.');
  assert(batch.samples.length === 1, 'TwinDeltaBatch sample count mismatch.');
  assert(batch.emittedAtUtc === '2026-09-06T12:00:00.010Z', 'TwinDeltaBatch timestamp mismatch.');
};

const runEstimatedStateTest = () => {
  const project = createTwinProjectFromAssetDocument(testDocument(), { timestampUtc: '2026-09-06T12:00:00.000Z' });
  const signal = project.signals.find((item) => item.metadata.stateKind === 'reported');
  assert(signal, 'Reported signal missing.');
  const estimated = setEstimatedValue(project, signal.id, { value: 0.12, uncertainty: 0.04, method: 'constant-velocity-estimator', updatedAtUtc: '2026-09-06T12:00:04.000Z' });
  assert(estimated.state.estimatedState[signal.id].method === 'constant-velocity-estimator', 'Estimated state did not persist method.');
  assertValid(estimated);
};

export const runTwinFoundationTests = () => {
  runFoundationCreationTest();
  runStateSeparationTest();
  runQualityAndStalenessTest();
  runMaturityTest();
  runCommandGovernanceTest();
  runDeltaBatchTest();
  runEstimatedStateTest();
  console.log('Twin foundation P0 tests passed.');
};
