import { defaultMaterial, type GeneratorId, type MaterialDefinition, type SceneNode, type Vector3Tuple } from '../../domain/model';
import type { KinematicGraph, KinematicJoint, KinematicMotionClip, KinematicState, MechanicalPart } from '../../domain/kinematics';

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const deg = (value: number) => (value * Math.PI) / 180;

type JointSpec = {
  id: string;
  name: string;
  parent: string;
  child: string;
  type: KinematicJoint['type'];
  axis: Vector3Tuple;
  origin: Vector3Tuple;
  lower?: number;
  upper?: number;
  home: number;
  velocity?: number;
  description: string;
  rigAxis?: 'X' | 'Y' | 'Z';
  coupling?: KinematicJoint['coupling'];
};

type IndustrialNodeInput = {
  name: string;
  generatorId: GeneratorId;
  material: MaterialDefinition;
  position: Vector3Tuple;
  rotation?: Vector3Tuple;
  bounds: Vector3Tuple;
  rootPart: string;
  parts: Array<{ id: string; name: string; objectNames: string[]; static?: boolean; center: Vector3Tuple; bounds?: Vector3Tuple }>;
  joints: JointSpec[];
  clips?: KinematicMotionClip[];
  params?: Record<string, number>;
};

const boundsFrom = (size: Vector3Tuple, center: Vector3Tuple) => ({
  min: [center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2] as Vector3Tuple,
  max: [center[0] + size[0] / 2, center[1] + size[1] / 2, center[2] + size[2] / 2] as Vector3Tuple,
  size,
  center,
});

const mechanicalPart = (input: IndustrialNodeInput['parts'][number]): MechanicalPart => ({
  id: input.id,
  name: input.name,
  meshObjectIds: input.objectNames,
  localFrame: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  bounds: boundsFrom(input.bounds ?? [0.2, 0.2, 0.2], input.center),
  static: Boolean(input.static),
  visible: true,
  source: 'manual-group',
  metadata: { industrialScenePack: true },
});

const kinematicJoint = (spec: JointSpec): KinematicJoint => ({
  id: spec.id,
  name: spec.name,
  parentPartId: spec.parent,
  childPartId: spec.child,
  type: spec.type,
  origin: { position: spec.origin, rotation: [0, 0, 0, 1] },
  axis: spec.axis,
  limits: { lower: spec.lower, upper: spec.upper, velocity: spec.velocity },
  source: 'model',
  confidence: 1,
  evidence: [
    {
      type: 'imported-hierarchy',
      score: 1,
      message: spec.description,
      metadata: { sourceSchema: 'escena-industrial/1.0', rigAxis: spec.rigAxis },
    },
  ],
  status: 'validated',
  motionProfile: spec.type === 'prismatic' ? 'linear-slide' : 'rotation-around-origin',
  coupling: spec.coupling,
});

const stateFrom = (joints: JointSpec[]): KinematicState => {
  const homeJointValues = Object.fromEntries(joints.map((joint) => [joint.id, joint.home]));
  return { homeJointValues, jointValues: { ...homeJointValues } };
};

const graphFrom = (input: IndustrialNodeInput): KinematicGraph => ({
  rootPartId: input.rootPart,
  parts: input.parts.map((part) => mechanicalPart(part)),
  joints: input.joints.map(kinematicJoint),
  motionClips: input.clips ?? [],
  analysisVersion: input.generatorId === 'industrial-conveyor-segment' ? 'conveyor-rig-industrial-scene-1' : 'industrial-scene-rig-1',
});

const nodeFrom = (input: IndustrialNodeInput): SceneNode => {
  const now = new Date().toISOString();
  return {
    id: id('node'),
    name: input.name,
    geometry: {
      kind: input.generatorId,
      generatorId: input.generatorId,
      params: input.params ?? {},
      originalBounds: input.bounds,
      normalizedBounds: input.bounds,
      kinematicGraph: graphFrom(input),
      kinematicState: stateFrom(input.joints),
    },
    transform: {
      position: input.position,
      rotation: input.rotation ?? [0, 0, 0],
      scale: [1, 1, 1],
    },
    material: input.material,
    visible: true,
    locked: false,
    createdAt: now,
  };
};

const clip = (idValue: string, name: string, duration: number, keyframes: KinematicMotionClip['keyframes'], description: string, loop = true): KinematicMotionClip => ({
  id: idValue,
  name,
  duration,
  loop,
  source: 'imported',
  description,
  keyframes,
});

const gantryNode = () => {
  const joints: JointSpec[] = [
    { id: 'G1', name: 'G1_column_yaw', parent: 'gantry_base', child: 'gantry_column', type: 'revolute', axis: [0, 1, 0], origin: [0, 0.135, 0], lower: deg(-180), upper: deg(180), home: 0, velocity: deg(45), rigAxis: 'Y', description: 'Column yaw rotates the complete column, boom, head and gripper over the base.' },
    { id: 'G2', name: 'G2_boom_extend', parent: 'gantry_column', child: 'gantry_boom', type: 'prismatic', axis: [1, 0, 0], origin: [0, 2.25, 0], lower: 0, upper: 0.55, home: 0.28, velocity: 0.35, rigAxis: 'X', description: 'Boom extension slides radially in X without adding rotation.' },
    { id: 'G3', name: 'G3_head_lift', parent: 'gantry_boom', child: 'gantry_head_lift', type: 'prismatic', axis: [0, 1, 0], origin: [1.62, 2.05, 0], lower: -0.62, upper: 0, home: 0, velocity: 0.45, rigAxis: 'Y', description: 'Vertical head lift descends with negative Y values.' },
    { id: 'G4', name: 'G4_head_roll', parent: 'gantry_head_lift', child: 'gantry_head_roll', type: 'revolute', axis: [0, 1, 0], origin: [1.62, 1.81, 0], lower: deg(-180), upper: deg(180), home: 0, velocity: deg(120), rigAxis: 'Y', description: 'Gripper plate roll rotates around the vertical head axis.' },
    { id: 'G5_0', name: 'G5_finger_0', parent: 'gantry_head_roll', child: 'gantry_finger_0', type: 'revolute', axis: [0, 0, 1], origin: [1.75, 1.77, 0.13], lower: deg(-8), upper: deg(24), home: deg(24), velocity: deg(90), rigAxis: 'Z', description: 'Gripper finger 0 opens and closes around its local Z knuckle.' },
    { id: 'G5_1', name: 'G5_finger_1', parent: 'gantry_head_roll', child: 'gantry_finger_1', type: 'revolute', axis: [0, 0, 1], origin: [1.49, 1.77, 0.13], lower: deg(-8), upper: deg(24), home: deg(24), velocity: deg(90), rigAxis: 'Z', description: 'Gripper finger 1 follows the gripper command.', coupling: { driverJointId: 'G5_0', multiplier: 1, offset: 0 } },
    { id: 'G5_2', name: 'G5_finger_2', parent: 'gantry_head_roll', child: 'gantry_finger_2', type: 'revolute', axis: [0, 0, 1], origin: [1.49, 1.77, -0.13], lower: deg(-8), upper: deg(24), home: deg(24), velocity: deg(90), rigAxis: 'Z', description: 'Gripper finger 2 follows the gripper command.', coupling: { driverJointId: 'G5_0', multiplier: 1, offset: 0 } },
    { id: 'G5_3', name: 'G5_finger_3', parent: 'gantry_head_roll', child: 'gantry_finger_3', type: 'revolute', axis: [0, 0, 1], origin: [1.75, 1.77, -0.13], lower: deg(-8), upper: deg(24), home: deg(24), velocity: deg(90), rigAxis: 'Z', description: 'Gripper finger 3 follows the gripper command.', coupling: { driverJointId: 'G5_0', multiplier: 1, offset: 0 } },
  ];
  const p = (time: number, g1: number, g2: number, g3: number, g4: number, g5: number) => ({ time, jointValues: { G1: deg(g1), G2: g2, G3: g3, G4: deg(g4), G5_0: deg(g5) } });
  return nodeFrom({
    name: 'Industrial Gantry Robot',
    generatorId: 'industrial-gantry-5axis',
    material: { ...defaultMaterial('Gantry Yellow', '#f2c019'), roughness: 0.42, metalness: 0.14 },
    position: [-4.35, 0, -1.15],
    rotation: [0, -0.785, 0],
    bounds: [3.3, 2.45, 1.4],
    rootPart: 'gantry_base',
    parts: [
      { id: 'gantry_base', name: 'BASE_fixed', objectNames: ['BASE_fixed'], static: true, center: [0, 0.08, 0], bounds: [1.4, 0.16, 1.4] },
      { id: 'gantry_column', name: 'G1_column_yaw', objectNames: ['G1_column_yaw'], center: [0, 1.2, 0], bounds: [0.5, 2.3, 0.35] },
      { id: 'gantry_boom', name: 'G2_boom_extend', objectNames: ['G2_boom_extend'], center: [0.95, 2.25, 0], bounds: [1.75, 0.32, 0.25] },
      { id: 'gantry_head_lift', name: 'G3_head_lift', objectNames: ['G3_head_lift'], center: [1.62, 1.94, 0], bounds: [0.24, 0.5, 0.24] },
      { id: 'gantry_head_roll', name: 'G4_head_roll', objectNames: ['G4_head_roll'], center: [1.62, 1.76, 0], bounds: [0.45, 0.18, 0.45] },
      ...[0, 1, 2, 3].map((index) => ({
        id: `gantry_finger_${index}`,
        name: `G5_finger_${index}`,
        objectNames: [`G5_finger_${index}`],
        center: [1.62, 1.62, 0] as Vector3Tuple,
        bounds: [0.08, 0.28, 0.08] as Vector3Tuple,
      })),
    ],
    joints,
    clips: [
      clip('gantry_cycle_unload', 'Ciclo Descarga', 12, [p(0, 0, 0.28, 0, 0, 24), p(1.6, -62, 0.5, 0, 0, 24), p(2.8, -62, 0.5, -0.58, 0, 24), p(3.6, -62, 0.5, -0.58, 0, -8), p(4.8, -62, 0.5, 0, 0, -8), p(7, 38, 0.34, 0, 90, -8), p(8.2, 38, 0.34, -0.42, 90, -8), p(9, 38, 0.34, -0.42, 90, 24), p(10, 38, 0.34, 0, 90, 24), p(12, 0, 0.28, 0, 0, 24)], 'Pick and place cycle from stack to input belt.'),
      clip('gantry_demo_axes', 'Demo Ejes', 17, [p(0, 0, 0.28, 0, 0, 24), p(1.8, -180, 0.28, 0, 0, 24), p(4.4, 180, 0.28, 0, 0, 24), p(6, 0, 0.28, 0, 0, 24), p(7.2, 0, 0.55, 0, 0, 24), p(8.4, 0, 0, 0, 0, 24), p(9.4, 0, 0.28, -0.62, 0, 24), p(10.6, 0, 0.28, 0, 0, 24), p(11.8, 0, 0.28, 0, 180, 24), p(13.4, 0, 0.28, 0, -180, 24), p(14.6, 0, 0.28, 0, 0, 24), p(15.6, 0, 0.28, 0, 0, -8), p(17, 0, 0.28, 0, 0, 24)], 'Axis-by-axis gantry acceptance demo.'),
    ],
  });
};

const inspectionNode = () => {
  const joints: JointSpec[] = [
    { id: 'M3', name: 'M3_door_hinge', parent: 'inspection_shell', child: 'inspection_door', type: 'revolute', axis: [0, 1, 0], origin: [-0.46, 0.1, 0.785], lower: 0, upper: deg(95), home: 0, velocity: deg(60), rigAxis: 'Y', description: 'Lower maintenance door opens around the vertical hinge at the -X edge of the front face.' },
    { id: 'M4', name: 'M4_fan', parent: 'inspection_shell', child: 'inspection_fan', type: 'continuous', axis: [0, 1, 0], origin: [-0.02, 2.1, 0.725], home: 0, rigAxis: 'Y', description: 'Fan rotor spins continuously behind the top grille around Y.' },
    { id: 'M6_IN', name: 'M6_curtain_in', parent: 'inspection_shell', child: 'inspection_curtain_in', type: 'revolute', axis: [0, 0, 1], origin: [-0.68, 1.39, 0], lower: 0, upper: deg(62), home: 0, velocity: deg(180), rigAxis: 'Z', description: 'Entrance curtain swings open as cargo enters the tunnel.' },
    { id: 'M6_OUT', name: 'M6_curtain_out', parent: 'inspection_shell', child: 'inspection_curtain_out', type: 'revolute', axis: [0, 0, 1], origin: [0.68, 1.39, 0], lower: deg(-62), upper: 0, home: 0, velocity: deg(180), rigAxis: 'Z', description: 'Exit curtain mirrors the entrance curtain with opposite sign.', coupling: { driverJointId: 'M6_IN', multiplier: -1, offset: 0 } },
  ];
  const p = (time: number, door: number, fan: number, curtain: number) => ({ time, jointValues: { M3: deg(door), M4: fan, M6_IN: deg(curtain) } });
  return nodeFrom({
    name: 'Inspection Machine',
    generatorId: 'industrial-inspection-machine',
    material: { ...defaultMaterial('Inspection Shell', '#e6e7e9'), roughness: 0.45, metalness: 0.14 },
    position: [0, 0, 0],
    bounds: [1.3, 2.52, 1.55],
    rootPart: 'inspection_shell',
    parts: [
      { id: 'inspection_shell', name: 'SHELL_fixed', objectNames: ['SHELL_fixed'], static: true, center: [0, 1.26, 0], bounds: [1.3, 2.52, 1.55] },
      { id: 'inspection_door', name: 'M3_door_hinge', objectNames: ['M3_door_hinge'], center: [-0.03, 0.4, 0.79], bounds: [0.86, 0.56, 0.04] },
      { id: 'inspection_fan', name: 'M4_fan', objectNames: ['M4_fan'], center: [-0.02, 2.1, 0.72], bounds: [0.35, 0.35, 0.08] },
      { id: 'inspection_curtain_in', name: 'M6_curtain_in', objectNames: ['M6_curtain_in'], center: [-0.68, 1.1, 0], bounds: [0.04, 0.58, 0.78] },
      { id: 'inspection_curtain_out', name: 'M6_curtain_out', objectNames: ['M6_curtain_out'], center: [0.68, 1.1, 0], bounds: [0.04, 0.58, 0.78] },
    ],
    joints,
    clips: [
      clip('inspection_cycle', 'Ciclo Inspeccion', 6, [p(0, 0, 0, 0), p(0.6, 0, -4, 58), p(2.4, 0, -16, 20), p(3, 0, -22, 0), p(6, 0, -44, 0)], 'Cargo inspection with curtain pulse and fan spin.'),
      clip('inspection_maintenance', 'Mantenimiento', 3, [p(0, 0, 0, 0), p(3, 95, -12, 0)], 'Open the maintenance door.'),
    ],
  });
};

const conveyorNode = (name: string, position: Vector3Tuple, length: number, label: string) => {
  const joints: JointSpec[] = [
    { id: `${label}_R1`, name: 'R1_drive_roller', parent: `${label}_frame`, child: `${label}_drive_roller`, type: 'continuous', axis: [0, 0, 1], origin: [length / 2 - 0.01, 0.775, 0], home: 0, rigAxis: 'Z', description: 'Drive roller turns around Z; belt distance derives from roller radians.' },
    { id: `${label}_R2`, name: 'R2_idler_roller', parent: `${label}_frame`, child: `${label}_idler_roller`, type: 'continuous', axis: [0, 0, 1], origin: [-length / 2 + 0.01, 0.775, 0], home: 0, rigAxis: 'Z', description: 'Return roller mirrors the drive roller speed.', coupling: { driverJointId: `${label}_R1`, multiplier: 1, offset: 0 } },
    { id: `${label}_S1`, name: 'S1_stopper', parent: `${label}_frame`, child: `${label}_stopper`, type: 'prismatic', axis: [0, 1, 0], origin: [length / 2 - 0.65, 0.85, 0], lower: -0.11, upper: 0, home: -0.11, velocity: 0.44, rigAxis: 'Y', description: 'Retaining stop moves vertically: 0 holds cargo, -0.11 releases it.' },
  ];
  return nodeFrom({
    name,
    generatorId: 'industrial-conveyor-segment',
    material: { ...defaultMaterial('Conveyor Frame', '#e6e7e9'), roughness: 0.46, metalness: 0.12 },
    position,
    bounds: [length, 0.9, 0.92],
    rootPart: `${label}_frame`,
    params: { length, label: label === 'A' ? 1 : 2 },
    parts: [
      { id: `${label}_frame`, name: 'FRAME_fixed', objectNames: ['FRAME_fixed', 'BELT_surface'], static: true, center: [0, 0.45, 0], bounds: [length, 0.9, 0.92] },
      { id: `${label}_drive_roller`, name: 'R1_drive_roller', objectNames: ['R1_drive_roller'], center: [length / 2 - 0.01, 0.775, 0], bounds: [0.16, 0.16, 0.62] },
      { id: `${label}_idler_roller`, name: 'R2_idler_roller', objectNames: ['R2_idler_roller'], center: [-length / 2 + 0.01, 0.775, 0], bounds: [0.16, 0.16, 0.62] },
      { id: `${label}_stopper`, name: 'S1_stopper', objectNames: ['S1_stopper'], center: [length / 2 - 0.65, 0.9, 0], bounds: [0.06, 0.18, 0.48] },
    ],
    joints,
    clips: [clip(`${label}_belt_run`, 'Run Belt', 8, [{ time: 0, jointValues: { [`${label}_R1`]: 0, [`${label}_S1`]: -0.11 } }, { time: 8, jointValues: { [`${label}_R1`]: -36, [`${label}_S1`]: -0.11 } }], 'Parametric belt and roller motion.')],
  });
};

const operatorNode = () => {
  const joints: JointSpec[] = [
    { id: 'O1', name: 'O1_hips_yaw', parent: 'operator_legs', child: 'operator_hips', type: 'revolute', axis: [0, 1, 0], origin: [0, 0.92, 0], lower: deg(-60), upper: deg(60), home: 0, rigAxis: 'Y', description: 'Hips yaw reorients the torso, arms and head.' },
    { id: 'O2', name: 'O2_spine_pitch', parent: 'operator_hips', child: 'operator_spine_pitch', type: 'revolute', axis: [0, 0, 1], origin: [0, 0.92, 0], lower: deg(-12), upper: deg(28), home: deg(4), rigAxis: 'Z', description: 'Torso pitches forward toward the panel.' },
    { id: 'O3', name: 'O3_spine_twist', parent: 'operator_spine_pitch', child: 'operator_spine_twist', type: 'revolute', axis: [0, 1, 0], origin: [0, 0.92, 0], lower: deg(-40), upper: deg(40), home: 0, rigAxis: 'Y', description: 'Independent torso twist.' },
    { id: 'O4', name: 'O4_head_yaw', parent: 'operator_spine_twist', child: 'operator_head_yaw', type: 'revolute', axis: [0, 1, 0], origin: [0, 1.54, 0], lower: deg(-75), upper: deg(75), home: 0, rigAxis: 'Y', description: 'Head yaw.' },
    { id: 'O5', name: 'O5_head_pitch', parent: 'operator_head_yaw', child: 'operator_head_pitch', type: 'revolute', axis: [0, 0, 1], origin: [0, 1.54, 0], lower: deg(-25), upper: deg(35), home: deg(8), rigAxis: 'Z', description: 'Head pitch.' },
    { id: 'O6', name: 'O6_shoulder_R', parent: 'operator_spine_twist', child: 'operator_shoulder_R', type: 'revolute', axis: [0, 0, 1], origin: [0.01, 1.4, 0.19], lower: deg(-100), upper: deg(100), home: deg(30), rigAxis: 'Z', description: 'Right shoulder advances toward +X.' },
    { id: 'O7', name: 'O7_elbow_R', parent: 'operator_shoulder_R', child: 'operator_elbow_R', type: 'revolute', axis: [0, 0, 1], origin: [0.01, 1.11, 0.19], lower: 0, upper: deg(130), home: deg(78), rigAxis: 'Z', description: 'Right elbow flexes for the panel press gesture.' },
    { id: 'O8', name: 'O8_shoulder_L', parent: 'operator_spine_twist', child: 'operator_shoulder_L', type: 'revolute', axis: [0, 0, 1], origin: [0.01, 1.4, -0.19], lower: deg(-100), upper: deg(100), home: deg(8), rigAxis: 'Z', description: 'Left shoulder.' },
    { id: 'O9', name: 'O9_elbow_L', parent: 'operator_shoulder_L', child: 'operator_elbow_L', type: 'revolute', axis: [0, 0, 1], origin: [0.01, 1.11, -0.19], lower: 0, upper: deg(130), home: deg(18), rigAxis: 'Z', description: 'Left elbow.' },
  ];
  const p = (time: number, values: Record<string, number> = {}) => ({
    time,
    jointValues: { O1: 0, O2: deg(4), O3: 0, O4: 0, O5: deg(8), O6: deg(30), O7: deg(78), O8: deg(8), O9: deg(18), ...values },
  });
  return nodeFrom({
    name: 'Industrial Operator',
    generatorId: 'industrial-operator',
    material: { ...defaultMaterial('Operator Coat', '#a9dcd2'), roughness: 0.72, metalness: 0.02 },
    position: [0.3, 0, 1.22],
    rotation: [0, Math.PI / 2, 0],
    bounds: [0.48, 1.75, 0.3],
    rootPart: 'operator_legs',
    parts: [
      { id: 'operator_legs', name: 'LEGS_fixed', objectNames: ['LEGS_fixed'], static: true, center: [0, 0.45, 0], bounds: [0.48, 0.9, 0.3] },
      ...joints.map((joint) => ({ id: joint.child, name: joint.name, objectNames: [joint.name], center: joint.origin, bounds: [0.3, 0.3, 0.3] as Vector3Tuple })),
    ],
    joints,
    clips: [
      clip('operator_panel', 'Operar Panel', 5, [p(0), p(0.8, { O6: deg(34), O7: deg(70), O5: deg(12) }), p(1.2, { O6: deg(32), O7: deg(86), O5: deg(12) }), p(2.1, { O6: deg(32), O7: deg(86), O5: deg(12) }), p(3, { O6: deg(33), O7: deg(84), O5: deg(6) }), p(5)], 'Operator presses the inspection machine panel.'),
      clip('operator_demo_axes', 'Demo Ejes', 14, [p(0), p(1, { O1: deg(-60) }), p(2, { O1: deg(60) }), p(3.4, { O2: deg(28) }), p(5.2, { O3: deg(40) }), p(7, { O4: deg(75) }), p(8.6, { O5: deg(35) }), p(10.2, { O6: deg(100), O7: deg(130) }), p(12.2, { O8: deg(100), O9: deg(130) }), p(14)], 'Axis-by-axis operator articulation demo.'),
    ],
  });
};

const cargoBoxNode = (position: Vector3Tuple, name = 'Cargo Box') => {
  const joints: JointSpec[] = [
    { id: 'L1', name: 'L1_lid_hinge', parent: 'box_body_part', child: 'box_lid_part', type: 'revolute', axis: [0, 0, 1], origin: [-0.21, 0.348, 0], lower: 0, upper: deg(105), home: 0, velocity: deg(120), rigAxis: 'Z', description: 'Top lid opens around the -X edge hinge.' },
  ];
  return nodeFrom({
    name,
    generatorId: 'industrial-cargo-box',
    material: { ...defaultMaterial('Carton', '#c79e68'), roughness: 0.78, metalness: 0.02 },
    position,
    bounds: [0.42, 0.36, 0.36],
    rootPart: 'box_body_part',
    parts: [
      { id: 'box_body_part', name: 'box_body', objectNames: ['box_body'], static: true, center: [0, 0.17, 0], bounds: [0.42, 0.34, 0.36] },
      { id: 'box_lid_part', name: 'L1_lid_hinge', objectNames: ['L1_lid_hinge'], center: [-0.21, 0.35, 0], bounds: [0.42, 0.02, 0.36] },
    ],
    joints,
    clips: [clip('box_open_lid', 'Abrir Tapa', 1.2, [{ time: 0, jointValues: { L1: 0 } }, { time: 1.2, jointValues: { L1: deg(105) } }], 'Open the top lid.', false)],
  });
};

const cargoStackNode = () =>
  nodeFrom({
    name: 'Cargo Box Stack',
    generatorId: 'industrial-cargo-stack',
    material: { ...defaultMaterial('Carton Stack', '#c79e68'), roughness: 0.78, metalness: 0.02 },
    position: [4.55, 0, 1.55],
    rotation: [0, 0.18, 0],
    bounds: [1.34, 0.7, 0.86],
    rootPart: 'stack_body',
    params: { rows: 2, cols: 3, depth: 2 },
    parts: [{ id: 'stack_body', name: 'cargo-box-stack', objectNames: ['cargo-box-stack'], static: true, center: [0, 0.35, 0], bounds: [1.34, 0.7, 0.86] }],
    joints: [],
  });

export const createIndustrialScenePackNodes = (): SceneNode[] => [
  inspectionNode(),
  conveyorNode('Conveyor A Input', [-2.3, 0, 0], 3.25, 'A'),
  conveyorNode('Conveyor B Output', [2.4, 0, 0], 3.45, 'B'),
  gantryNode(),
  operatorNode(),
  cargoStackNode(),
  cargoBoxNode([-3.38, 0, -0.92], 'Loose Box 1'),
  cargoBoxNode([-3.0, 0, -1.32], 'Loose Box 2'),
  cargoBoxNode([-2.62, 0, -0.68], 'Loose Box 3'),
  cargoBoxNode([-1.68, 0, -1.18], 'Loose Box 4'),
  cargoBoxNode([2.1, 0.86, 0], 'Cargo Box B1'),
];

export const industrialSceneModelIds = [
  'industrial-inspection-machine',
  'industrial-conveyor-segment',
  'industrial-gantry-5axis',
  'industrial-operator',
  'industrial-cargo-stack',
  'industrial-cargo-box',
] as const;

export type IndustrialSceneModelId = (typeof industrialSceneModelIds)[number];

export const createIndustrialSceneModelNode = (modelId: IndustrialSceneModelId): SceneNode => {
  if (modelId === 'industrial-inspection-machine') return inspectionNode();
  if (modelId === 'industrial-conveyor-segment') return conveyorNode('Conveyor Segment', [0, 0, 0], 3.25, 'A');
  if (modelId === 'industrial-gantry-5axis') {
    const node = gantryNode();
    return { ...node, transform: { ...node.transform, position: [0, 0, 0], rotation: [0, 0, 0] } };
  }
  if (modelId === 'industrial-operator') {
    const node = operatorNode();
    return { ...node, transform: { ...node.transform, position: [0, 0, 0], rotation: [0, 0, 0] } };
  }
  if (modelId === 'industrial-cargo-stack') {
    const node = cargoStackNode();
    return { ...node, transform: { ...node.transform, position: [0, 0, 0], rotation: [0, 0, 0] } };
  }
  return cargoBoxNode([0, 0, 0]);
};
