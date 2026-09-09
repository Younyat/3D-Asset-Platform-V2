import type { AssetDocument } from '../../domain/model';
import type { KinematicGraph } from '../../domain/kinematics';
import type { TwinBinding, TwinProject, TwinSignal } from '../../domain/twin';
import { evaluateAlarmRules, acknowledgeAlarm, shelveAlarm } from './alarmEngine';
import { confirmCommandFromFeedback, evaluateCommandGates, expireCommands, requestGovernedCommand } from './commandEngine';
import { applyDataBusSamples, applyEngineeringTransform, TwinDataBus } from './dataBus';
import { deterministicReplayHash, downsampleSamples, MemoryHistorian, replayRecords } from './historianReplay';
import { decodeModbusBlockSamples, decodeModbusValue, encodeModbusValue, modbusDisplayAddressToWire, planModbusReadBlocks } from './modbusCodec';
import { decodeMqttPublish, MqttDuplicateDetector, mqttTopicMatches, sparkplugLifecycleFromPacket } from './mqttCodec';
import { createPlcTwinProjectForNode, runPlcModbusSimulationFrame } from './plcModbusSimulation';
import { createTwinProjectFromAssetDocument, makeSample, setDesiredValue } from './twinFoundation';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const graph = (): KinematicGraph => ({
  rootPartId: 'base',
  parts: [
    {
      id: 'base',
      name: 'base',
      meshObjectIds: ['base'],
      localFrame: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      bounds: { min: [-1, 0, -1], max: [1, 0.2, 1], size: [2, 0.2, 2], center: [0, 0.1, 0] },
      static: true,
      visible: true,
      source: 'manual-group',
      metadata: {},
    },
    {
      id: 'arm',
      name: 'arm',
      meshObjectIds: ['arm'],
      localFrame: { position: [0, 0.2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      bounds: { min: [-0.2, 0.2, -0.2], max: [0.2, 1, 0.2], size: [0.4, 0.8, 0.4], center: [0, 0.6, 0] },
      static: false,
      visible: true,
      source: 'manual-group',
      metadata: {},
    },
  ],
  joints: [
    {
      id: 'j1',
      name: 'J1',
      parentPartId: 'base',
      childPartId: 'arm',
      type: 'revolute',
      origin: { position: [0, 0.2, 0], rotation: [0, 0, 0, 1] },
      axis: [0, 1, 0],
      limits: { lower: -1, upper: 1, velocity: 1 },
      source: 'model',
      confidence: 1,
      evidence: [{ type: 'manual', score: 1 }],
      status: 'validated',
    },
  ],
});

const document = (): AssetDocument => ({
  schemaVersion: 1,
  metadata: {
    id: 'runtime-test',
    name: 'Runtime Test',
    author: 'test',
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  },
  nodes: [
    {
      id: 'robot',
      name: 'Robot',
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
        kinematicGraph: graph(),
      },
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      material: { name: 'm', color: '#ffffff', roughness: 0.5, metalness: 0.1 },
      visible: true,
      locked: false,
      createdAt: '2026-09-06T00:00:00.000Z',
    },
  ],
});

const project = () => createTwinProjectFromAssetDocument(document(), { timestampUtc: '2026-09-06T12:00:00.000Z' });

const signalByKind = (projectInput: TwinProject, kind: string): TwinSignal => {
  const signal = projectInput.signals.find((item) => item.metadata.stateKind === kind);
  assert(signal, `Missing ${kind} signal.`);
  return signal;
};

const withModbusBinding = (projectInput: TwinProject, signal: TwinSignal, bindingPatch: Partial<TwinBinding> = {}) => {
  const binding: TwinBinding = {
    id: `binding_${signal.id}`,
    signalId: signal.id,
    connectionId: 'plc01',
    protocol: 'modbus',
    mapping: { kind: 'modbus', area: 'holding-register', address: 100, quantity: 2, dataType: 'f32', byteOrder: 'be', wordOrder: 'high-low' },
    transform: { scale: 0.1, offset: -10, unitIn: 'register', unitOut: 'deg' },
    enabled: true,
    metadata: {},
    ...bindingPatch,
  };
  return {
    ...projectInput,
    mode: 'live' as const,
    bindings: [...projectInput.bindings, binding],
    signals: projectInput.signals.map((item) => (item.id === signal.id ? { ...item, bindingId: binding.id } : item)),
    connectionHealth: [{ connectionId: 'plc01', protocol: 'modbus' as const, state: 'ONLINE' as const, quality: 'GOOD' as const, updatedAtUtc: '2026-09-06T12:00:00.000Z' }],
  };
};

const runDataBusTests = () => {
  let p = project();
  const actual = signalByKind(p, 'reported');
  p = withModbusBinding(p, actual);
  const binding = p.bindings[0];
  const transformed = applyEngineeringTransform(374, binding.transform);
  assert(typeof transformed === 'number' && Math.abs(transformed - 27.4) < 0.000001, 'Engineering transform did not apply scale and offset.');
  const result = applyDataBusSamples(
    p,
    [
      { bindingId: binding.id, value: 374, quality: 'GOOD', sequence: 1, sourceTimestampUtc: '2026-09-06T12:00:01.000Z', ingestTimestampUtc: '2026-09-06T12:00:01.010Z' },
      { bindingId: binding.id, value: 374.01, quality: 'GOOD', sequence: 2, sourceTimestampUtc: '2026-09-06T12:00:01.020Z', ingestTimestampUtc: '2026-09-06T12:00:01.030Z' },
      { signalId: 'missing', value: 1, quality: 'GOOD', sequence: 3, ingestTimestampUtc: '2026-09-06T12:00:01.040Z' },
    ],
    { sequence: 10, emittedAtUtc: '2026-09-06T12:00:01.050Z', deadband: { absolute: 0.01, relative: 0, heartbeatMs: 1000 } },
  );
  assert(result.batch.samples.length === 2, 'Data bus did not emit first two samples against initial stale state.');
  assert(result.rejected === 1, 'Data bus did not reject unknown signal.');
  assert(result.batch.events.length === 1, 'Data bus did not create event for rejected sample.');

  const bus = new TwinDataBus(p);
  bus.ingest([{ bindingId: binding.id, value: 390, sequence: 4, ingestTimestampUtc: '2026-09-06T12:00:02.000Z', sourceTimestampUtc: '2026-09-06T12:00:02.000Z' }], { sequence: 11 });
  assert(bus.snapshot().emittedSamples === 1, 'TwinDataBus did not track emitted samples.');
};

const runModbusTests = () => {
  const mapping = { kind: 'modbus' as const, area: 'holding-register' as const, address: 100, quantity: 2, dataType: 'f32' as const, byteOrder: 'be' as const, wordOrder: 'high-low' as const };
  const encoded = encodeModbusValue(37.4, mapping);
  assert(encoded.functionCode === 16 && encoded.registers?.length === 2, 'Modbus f32 did not encode as multi-register write.');
  const decoded = decodeModbusValue(encoded.registers ?? [], mapping);
  assert(Math.abs(Number(decoded) - 37.4) < 0.0001, 'Modbus f32 decode did not roundtrip.');
  const swapped = { ...mapping, wordOrder: 'low-high' as const };
  const swappedEncoded = encodeModbusValue(37.4, swapped);
  assert(JSON.stringify(swappedEncoded.registers) !== JSON.stringify(encoded.registers), 'Modbus word order was ignored.');
  assert(modbusDisplayAddressToWire('40101').address === 100, 'Modbus display address conversion failed.');

  const p = project();
  const actual = signalByKind(p, 'reported');
  const p1 = withModbusBinding(p, actual);
  const secondSignal = { ...actual, id: `${actual.id}_temperature`, path: 'plant/cell01/temp.actual' };
  const secondBinding: TwinBinding = {
    id: 'binding_temp',
    signalId: secondSignal.id,
    connectionId: 'plc01',
    protocol: 'modbus',
    mapping: { kind: 'modbus', area: 'holding-register', address: 102, quantity: 1, dataType: 'i16', byteOrder: 'be' },
    enabled: true,
    metadata: {},
  };
  const blocks = planModbusReadBlocks([...p1.bindings, secondBinding], { maxGap: 0 });
  assert(blocks.length === 1 && blocks[0].address === 100 && blocks[0].quantity === 3, 'Modbus planner did not coalesce contiguous registers.');
  const samples = decodeModbusBlockSamples(blocks[0], [...(encoded.registers ?? []), 215], [...p1.bindings, secondBinding], 20, '2026-09-06T12:00:02.000Z');
  assert(samples.length === 2 && samples[1].value === 215, 'Modbus block decoder did not split values per binding.');
};

const runMqttTests = () => {
  assert(mqttTopicMatches('plant/+/robot/#', 'plant/a/robot/j1'), 'MQTT wildcard match failed.');
  assert(!mqttTopicMatches('plant/+/robot', 'plant/a/robot/j1'), 'MQTT wildcard matched too much.');
  const p = project();
  const actual = signalByKind(p, 'reported');
  const binding: TwinBinding = {
    id: 'mqtt_j1',
    signalId: actual.id,
    connectionId: 'broker01',
    protocol: 'mqtt',
    mapping: { kind: 'mqtt', topic: 'plant/cell01/robot/j1', payload: 'json', valuePath: '$.value', qos: 1, retained: false },
    enabled: true,
    metadata: {},
  };
  const detector = new MqttDuplicateDetector();
  const decoded = decodeMqttPublish(
    { topic: 'plant/cell01/robot/j1', payload: '{"value":0.25}', qos: 1, messageId: '42', receivedAtUtc: '2026-09-06T12:00:03.000Z' },
    [binding],
    { duplicateDetector: detector, sequenceStart: 30 },
  );
  assert(decoded.samples.length === 1 && decoded.samples[0].value === 0.25, 'MQTT JSON selector did not decode value.');
  const duplicate = decodeMqttPublish(
    { topic: 'plant/cell01/robot/j1', payload: '{"value":0.25}', qos: 1, messageId: '42', receivedAtUtc: '2026-09-06T12:00:03.100Z' },
    [binding],
    { duplicateDetector: detector, sequenceStart: 31 },
  );
  assert(duplicate.duplicate && duplicate.samples.length === 0, 'MQTT duplicate detector did not reject QoS1 duplicate.');
  const lifecycle = sparkplugLifecycleFromPacket({ topic: 'spBv1.0/group/NDEATH/edge', payload: '{"bdSeq":7}', receivedAtUtc: '2026-09-06T12:00:04.000Z' });
  assert(lifecycle?.messageType === 'NDEATH' && lifecycle.online === false && lifecycle.bdSeq === 7, 'Sparkplug NDEATH lifecycle was not parsed.');
};

const runCommandTests = () => {
  let p = project();
  const actual = signalByKind(p, 'reported');
  const desired = signalByKind(p, 'desired');
  p = withModbusBinding(
    {
      ...p,
      signals: p.signals.map((signal) => (signal.id === desired.id ? { ...signal, range: { min: -1, max: 1 } } : signal)),
    },
    desired,
  );
  p = applyDataBusSamples(p, [{ signalId: actual.id, value: 0.45, quality: 'GOOD', sequence: 41, sourceTimestampUtc: '2026-09-06T12:00:04.000Z', ingestTimestampUtc: '2026-09-06T12:00:04.000Z' }], { sequence: 40 }).project;
  const denied = evaluateCommandGates({ ...p, mode: 'replay' }, { id: 'cmd-denied', signalId: desired.id, value: 0.5, requestedBy: 'operator1', role: 'operator', ttlMs: 5000, requestedAtUtc: '2026-09-06T12:00:04.100Z' });
  assert(!denied.allowed && denied.reasons.some((reason) => reason.includes('live mode')), 'Command gates allowed replay write.');
  const requested = requestGovernedCommand(p, {
    id: 'cmd-ok',
    signalId: desired.id,
    value: 0.45,
    requestedBy: 'operator1',
    role: 'operator',
    ttlMs: 1000,
    requestedAtUtc: '2026-09-06T12:00:04.100Z',
    preconditions: [{ kind: 'feedback-good', signalId: actual.id, maxAgeMs: 1000 }],
  });
  assert(requested.gates.allowed, `Command gates rejected valid request: ${requested.gates.reasons.join(' ')}`);
  const confirmed = confirmCommandFromFeedback(requested.project, { commandId: 'cmd-ok', feedbackSignalId: actual.id, tolerance: 0.01, atUtc: '2026-09-06T12:00:04.500Z' });
  assert(confirmed.confirmed, 'Command was not confirmed by readback feedback.');
  const expired = expireCommands(requested.project, '2026-09-06T12:00:06.000Z');
  assert(expired.commands.find((command) => command.id === 'cmd-ok')?.status === 'EXPIRED', 'Command TTL expiry did not update pending command.');
};

const runHistorianReplayTests = () => {
  const p = project();
  const actual = signalByKind(p, 'reported');
  const historian = new MemoryHistorian();
  const samples = [
    makeSample(actual.id, 1, 'GOOD', 2, '2026-09-06T12:00:02.000Z', '2026-09-06T12:00:02.000Z'),
    makeSample(actual.id, 0, 'GOOD', 1, '2026-09-06T12:00:01.000Z', '2026-09-06T12:00:01.000Z'),
    makeSample(actual.id, 8, 'OUT_OF_RANGE', 3, '2026-09-06T12:00:02.500Z', '2026-09-06T12:00:02.500Z'),
  ];
  historian.appendSamples(samples);
  const queried = historian.queryWindow('2026-09-06T12:00:00.000Z', '2026-09-06T12:00:03.000Z');
  assert(queried[0].sequence === 1, 'Historian did not preserve deterministic order.');
  const framesA = replayRecords(p, queried);
  const framesB = replayRecords(p, queried);
  assert(deterministicReplayHash(framesA) === deterministicReplayHash(framesB), 'Replay hash is not deterministic.');
  const buckets = downsampleSamples(samples, 1000);
  assert(buckets.some((bucket) => bucket.max === 8 && bucket.worstQuality === 'OUT_OF_RANGE'), 'Downsample did not preserve max and worst quality.');
};

const runAlarmTests = () => {
  let p = project();
  const actual = signalByKind(p, 'reported');
  const desired = signalByKind(p, 'desired');
  p = setDesiredValue(p, desired.id, 0, '2026-09-06T12:00:00.000Z');
  p = applyDataBusSamples(p, [{ signalId: actual.id, value: 5, quality: 'GOOD', sequence: 50, sourceTimestampUtc: '2026-09-06T12:00:05.000Z', ingestTimestampUtc: '2026-09-06T12:00:05.000Z' }], { sequence: 50 }).project;
  const rules = [
    { id: 'high-j1', name: 'J1 high', priority: 'high' as const, kind: 'high' as const, signalId: actual.id, limit: 1, onDelayMs: 500, offDelayMs: 500, enabled: true },
    { id: 'dev-j1', name: 'J1 deviation', priority: 'medium' as const, kind: 'deviation' as const, actualSignalId: actual.id, desiredSignalId: desired.id, tolerance: 0.2, enabled: true },
  ];
  let evaluated = evaluateAlarmRules(p, rules, [], '2026-09-06T12:00:05.000Z');
  assert(evaluated.instances[0].state === 'pending-active', 'Alarm on-delay did not create pending state.');
  evaluated = evaluateAlarmRules(p, rules, evaluated.instances, '2026-09-06T12:00:05.700Z');
  assert(evaluated.instances[0].state === 'active' && evaluated.events.some((event) => event.type === 'alarm'), 'Alarm did not activate after on-delay.');
  const acked = acknowledgeAlarm(evaluated.instances, 'alarm_high-j1', '2026-09-06T12:00:05.800Z');
  assert(acked.find((instance) => instance.ruleId === 'high-j1')?.state === 'acked', 'Alarm acknowledgement failed.');
  const shelved = shelveAlarm(acked, 'alarm_high-j1', '2026-09-06T12:10:00.000Z', '2026-09-06T12:00:05.900Z');
  assert(shelved.find((instance) => instance.ruleId === 'high-j1')?.state === 'shelved', 'Alarm shelving failed.');
};

const runPlcSimulationDashboardTests = () => {
  const node = document().nodes[0];
  const projectInput = createPlcTwinProjectForNode(node, { timestampUtc: '2026-09-06T12:00:00.000Z' });
  assert(projectInput.mode === 'live', 'PLC simulation dashboard must exercise the live data path.');
  assert(projectInput.bindings.length === graph().joints.length, 'PLC simulation did not create one Modbus binding per joint.');
  const frameA = runPlcModbusSimulationFrame(node, { project: projectInput, elapsedSeconds: 0.1, sequence: 100, nowMs: Date.parse('2026-09-06T12:00:01.000Z') });
  const frameB = runPlcModbusSimulationFrame(node, { project: frameA.project, elapsedSeconds: 1.8, sequence: 101, nowMs: Date.parse('2026-09-06T12:00:02.000Z') });
  assert(frameA.physicalRegisters.length === graph().joints.length, 'PLC simulation did not expose physical Modbus registers.');
  assert(frameA.digitalTwinState.length === graph().joints.length, 'PLC simulation did not expose digital twin state.');
  const jointId = graph().joints[0].id;
  assert(Number.isFinite(frameB.jointValues[jointId]), 'PLC simulation did not map Modbus sample to kinematic joint value.');
  assert(frameA.jointValues[jointId] !== frameB.jointValues[jointId], 'PLC simulation did not produce changing movement.');
  assert(frameB.project.state.reportedState[frameB.samples[0].signalId].quality === 'GOOD', 'PLC simulation did not write GOOD reported state.');
};

export const runTwinRuntimeTests = () => {
  runDataBusTests();
  runModbusTests();
  runMqttTests();
  runCommandTests();
  runHistorianReplayTests();
  runAlarmTests();
  runPlcSimulationDashboardTests();
  console.log('Twin runtime application tests passed.');
};
