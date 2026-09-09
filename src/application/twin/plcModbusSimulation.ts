import type { KinematicGraph, KinematicMotionClip, KinematicState } from '../../domain/kinematics';
import type { AssetDocument, SceneNode } from '../../domain/model';
import type { ModbusMapping, TwinBinding, TwinProject, TwinSignal, TwinSignalSample } from '../../domain/twin';
import { sampleKinematicMotionClip } from '../kinematics/robotMotionController';
import { applyDataBusSamples } from './dataBus';
import { decodeModbusBlockSamples, encodeModbusValue, planModbusReadBlocks } from './modbusCodec';
import { createTwinProjectFromAssetDocument, validateTwinProject } from './twinFoundation';

export type PlcRegister = {
  address: number;
  displayAddress: string;
  signalId: string;
  jointId: string;
  jointName: string;
  value: number;
  registers: number[];
};

export type PlcModbusPacket = {
  direction: 'request' | 'response';
  transactionId: number;
  unitId: number;
  functionCode: number;
  area: string;
  address: number;
  quantity: number;
  bindingIds: string[];
  hex: string;
  decoded: string;
};

export type PlcSimulationFrame = {
  project: TwinProject;
  samples: TwinSignalSample[];
  jointValues: Record<string, number>;
  physicalRegisters: PlcRegister[];
  modbusPackets: PlcModbusPacket[];
  digitalTwinState: Array<{
    jointId: string;
    jointName: string;
    value: number;
    quality: string;
    ageMs: number;
    signalPath: string;
    modbusAddress: string;
  }>;
  diagnostics: string[];
};

const timestamp = (timeMs: number) => new Date(timeMs).toISOString();

const graphFromNode = (node: SceneNode): KinematicGraph | undefined =>
  'kinematicGraph' in node.geometry && node.geometry.kinematicGraph ? node.geometry.kinematicGraph : undefined;

const stateFromNode = (node: SceneNode, graph: KinematicGraph): KinematicState => {
  if ('kinematicState' in node.geometry && node.geometry.kinematicState) return node.geometry.kinematicState;
  const homeJointValues = Object.fromEntries(graph.joints.map((joint) => [joint.id, 0]));
  return { homeJointValues, jointValues: { ...homeJointValues } };
};

const actualJointSignals = (project: TwinProject) =>
  project.signals.filter((signal) => signal.access === 'read' && signal.metadata.stateKind === 'reported' && typeof signal.metadata.jointId === 'string');

const isModbusBinding = (binding: TwinBinding): binding is TwinBinding & { mapping: ModbusMapping } =>
  binding.protocol === 'modbus' && binding.mapping.kind === 'modbus';

const motionClipForGraph = (graph: KinematicGraph): KinematicMotionClip | undefined =>
  graph.motionClips?.find((clip) => /pick|place|ciclo|cycle|demo|asistencia|toma/i.test(clip.name)) ?? graph.motionClips?.[0];

const sampledJointValues = (graph: KinematicGraph, state: KinematicState, elapsedSeconds: number) => {
  const clip = motionClipForGraph(graph);
  if (clip) return sampleKinematicMotionClip(clip, elapsedSeconds);
  const values: Record<string, number> = {};
  graph.joints.forEach((joint, index) => {
    if (joint.type === 'fixed') {
      values[joint.id] = state.homeJointValues[joint.id] ?? 0;
      return;
    }
    const lower = joint.limits?.lower ?? (joint.type === 'prismatic' ? -0.25 : -0.75);
    const upper = joint.limits?.upper ?? (joint.type === 'prismatic' ? 0.25 : 0.75);
    const center = (lower + upper) / 2;
    const amplitude = Math.max(0, Math.min(Math.abs(upper - center), Math.abs(center - lower), joint.type === 'prismatic' ? 0.22 : 0.85));
    values[joint.id] = center + Math.sin(elapsedSeconds * (0.55 + index * 0.13)) * amplitude;
  });
  return values;
};

const wordsToHex = (words: number[]) =>
  words
    .flatMap((word) => [(word >> 8) & 0xff, word & 0xff])
    .map((byte) => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');

const modbusTcpHex = (transactionId: number, unitId: number, pdu: number[]) => {
  const length = pdu.length + 1;
  const bytes = [
    (transactionId >> 8) & 0xff,
    transactionId & 0xff,
    0,
    0,
    (length >> 8) & 0xff,
    length & 0xff,
    unitId,
    ...pdu,
  ];
  return bytes.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
};

export const createPlcTwinProjectForNode = (node: SceneNode, options: { timestampUtc?: string; connectionId?: string } = {}) => {
  const graph = graphFromNode(node);
  if (!graph) throw new Error(`${node.name} has no KinematicGraph for PLC simulation.`);
  const projectDocument: AssetDocument = {
    schemaVersion: 1,
    metadata: {
      id: `plc-test-${node.id}`,
      name: `${node.name} PLC Test`,
      author: 'local-simulator',
      createdAt: options.timestampUtc ?? new Date().toISOString(),
      updatedAt: options.timestampUtc ?? new Date().toISOString(),
    },
    nodes: [node],
    selectedNodeId: node.id,
  };
  const base = createTwinProjectFromAssetDocument(projectDocument, { mode: 'live', timestampUtc: options.timestampUtc ?? new Date().toISOString() });
  const connectionId = options.connectionId ?? 'sim-plc01';
  const signals = actualJointSignals(base);
  const bindings: TwinBinding[] = signals.map((signal, index) => ({
    id: `modbus_${signal.id}`,
    signalId: signal.id,
    connectionId,
    protocol: 'modbus',
    mapping: {
      kind: 'modbus',
      area: 'holding-register',
      address: 100 + index * 2,
      quantity: 2,
      dataType: 'f32',
      byteOrder: 'be',
      wordOrder: 'high-low',
      displayAddress: String(40101 + index * 2),
    },
    enabled: true,
    metadata: { source: 'local-plc-simulator', jointId: signal.metadata.jointId },
  }));
  const project: TwinProject = {
    ...base,
    bindings,
    signals: base.signals.map((signal) => {
      const binding = bindings.find((item) => item.signalId === signal.id);
      return binding ? { ...signal, bindingId: binding.id } : signal;
    }),
    connectionHealth: [
      {
        connectionId,
        protocol: 'modbus',
        state: 'ONLINE',
        quality: 'GOOD',
        updatedAtUtc: options.timestampUtc ?? new Date().toISOString(),
        message: 'Local PLC/Modbus simulator',
        metrics: { reconnectCount: 0 },
      },
    ],
  };
  const errors = validateTwinProject(project).filter((issue) => issue.severity === 'error');
  if (errors.length) throw new Error(`PLC simulation TwinProject is invalid: ${errors.map((issue) => issue.code).join(', ')}`);
  return project;
};

export const runPlcModbusSimulationFrame = (
  node: SceneNode,
  options: {
    project?: TwinProject;
    elapsedSeconds: number;
    sequence: number;
    nowMs: number;
    registerOverrides?: Record<string, number>;
  },
): PlcSimulationFrame => {
  const graph = graphFromNode(node);
  if (!graph) throw new Error(`${node.name} has no KinematicGraph for PLC simulation.`);
  const state = stateFromNode(node, graph);
  const project = options.project ?? createPlcTwinProjectForNode(node, { timestampUtc: timestamp(options.nowMs) });
  const physicalValues = sampledJointValues(graph, state, options.elapsedSeconds);
  const bindings = project.bindings.filter(isModbusBinding);
  const signalById = new Map(project.signals.map((signal) => [signal.id, signal]));
  const jointById = new Map(graph.joints.map((joint) => [joint.id, joint]));
  const physicalRegisters: PlcRegister[] = bindings.map((binding) => {
    const signal = signalById.get(binding.signalId) as TwinSignal | undefined;
    const jointId = String(signal?.metadata.jointId ?? binding.metadata.jointId ?? '');
    const joint = jointById.get(jointId);
    const overrideValue =
      options.registerOverrides?.[binding.signalId] ??
      options.registerOverrides?.[jointId] ??
      options.registerOverrides?.[binding.mapping.displayAddress ?? ''];
    const value = overrideValue ?? physicalValues[jointId] ?? state.homeJointValues[jointId] ?? 0;
    const write = encodeModbusValue(value, binding.mapping);
    return {
      address: binding.mapping.address,
      displayAddress: binding.mapping.displayAddress ?? String(40001 + binding.mapping.address),
      signalId: binding.signalId,
      jointId,
      jointName: joint?.name ?? signal?.path ?? jointId,
      value,
      registers: write.registers ?? [value ? 1 : 0],
    };
  });

  const blocks = planModbusReadBlocks(bindings, { maxGap: 0 });
  const modbusPackets: PlcModbusPacket[] = [];
  const rawSamples = blocks.flatMap((block) => {
    const registers: number[] = Array.from({ length: block.quantity }, () => 0);
    block.bindingIds.forEach((bindingId) => {
      const register = physicalRegisters.find((item) => project.bindings.find((binding) => binding.id === bindingId)?.signalId === item.signalId);
      if (!register) return;
      const offset = register.address - block.address;
      register.registers.forEach((value, index) => {
        registers[offset + index] = value;
      });
    });
    const transactionId = options.sequence + modbusPackets.length + 1;
    const unitId = 1;
    modbusPackets.push({
      direction: 'request',
      transactionId,
      unitId,
      functionCode: 3,
      area: block.area,
      address: block.address,
      quantity: block.quantity,
      bindingIds: block.bindingIds,
      hex: modbusTcpHex(transactionId, unitId, [0x03, (block.address >> 8) & 0xff, block.address & 0xff, (block.quantity >> 8) & 0xff, block.quantity & 0xff]),
      decoded: `Read Holding Registers ${40001 + block.address}-${40000 + block.address + block.quantity}`,
    });
    modbusPackets.push({
      direction: 'response',
      transactionId,
      unitId,
      functionCode: 3,
      area: block.area,
      address: block.address,
      quantity: block.quantity,
      bindingIds: block.bindingIds,
      hex: modbusTcpHex(transactionId, unitId, [0x03, registers.length * 2, ...registers.flatMap((word) => [(word >> 8) & 0xff, word & 0xff])]),
      decoded: `${registers.length} registers: ${wordsToHex(registers)}`,
    });
    return decodeModbusBlockSamples(block, registers, bindings, options.sequence, timestamp(options.nowMs), timestamp(options.nowMs));
  });
  const applied = applyDataBusSamples(project, rawSamples, { sequence: options.sequence, emittedAtUtc: timestamp(options.nowMs), deadband: { absolute: 0, heartbeatMs: 0 } });
  const jointValues = Object.fromEntries(
    applied.batch.samples
      .map((sample) => {
        const signal = signalById.get(sample.signalId);
        const jointId = String(signal?.metadata.jointId ?? '');
        return [jointId, Number(sample.value)];
      })
      .filter(([jointId, value]) => jointId && Number.isFinite(value)),
  ) as Record<string, number>;
  const digitalTwinState = applied.batch.samples.map((sample) => {
    const signal = signalById.get(sample.signalId);
    const jointId = String(signal?.metadata.jointId ?? '');
    const register = physicalRegisters.find((item) => item.signalId === sample.signalId);
    return {
      jointId,
      jointName: register?.jointName ?? jointId,
      value: Number(sample.value),
      quality: sample.quality,
      ageMs: Math.max(0, options.nowMs - Date.parse(sample.sourceTimestampUtc ?? sample.ingestTimestampUtc)),
      signalPath: signal?.path ?? sample.signalId,
      modbusAddress: register?.displayAddress ?? '',
    };
  });
  return {
    project: applied.project,
    samples: applied.batch.samples,
    jointValues,
    physicalRegisters,
    modbusPackets,
    digitalTwinState,
    diagnostics: applied.batch.events.map((event) => event.message),
  };
};
