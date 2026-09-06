import * as THREE from 'three';
import type { ImportedJointPose, Vector3Tuple } from '../../domain/model';
import type { KinematicGraph, KinematicJoint, KinematicMotionClip, KinematicState, MechanicalPart } from '../../domain/kinematics';
import { createJointFrame } from './geometryAnalysis';
import { normalizeAxis } from './kinematicAuthoring';

type RigAxis = 'X' | 'Y' | 'Z';

type RobotArmRigJointMetadata = {
  name: string;
  order?: string;
  type: 'revolute' | 'continuous' | 'prismatic' | 'fixed';
  axis: RigAxis;
  axisVector?: Vector3Tuple;
  parent?: string;
  pivotObjectName?: string;
  originMeters?: [number, number, number];
  limitsDeg?: [number, number];
  limitsMeters?: [number, number];
  homeDeg?: number;
  homeMeters?: number;
  maxSpeedDegPerSec?: number;
  maxSpeedMetersPerSec?: number;
  morphology?: {
    method: 'rounded-body' | 'contact';
    score?: number;
    sourceObjectNames?: string[];
  };
};

type RobotArmRigMetadata = {
  schema: string;
  units?: string;
  up?: string;
  joints?: RobotArmRigJointMetadata[];
  gripper?: {
    type?: string;
    axis?: RigAxis;
    openMeters?: number;
    closedMeters?: number;
    strokeMeters?: number;
  };
  clips?: Array<{ name: string; durationSec?: number; loop?: boolean }>;
};

type RobotArmPoseKey = {
  t: number;
  phase?: string;
  J1?: number;
  J2?: number;
  J3?: number;
  J4?: number;
  J5?: number;
  grip?: number;
};

type GenericRigPoseKey = {
  t: number;
  phase?: string;
  grip?: number;
  [key: string]: string | number | undefined;
};

type StaticRigSpec = {
  filePattern: RegExp;
  assetName: string;
  rootName: string;
  sourceSchema: string;
  analysisVersion: string;
  rootPartName: string;
  parts: Array<{ name: string; meshObjectIds: string[]; static?: boolean }>;
  joints: RobotArmRigJointMetadata[];
  gripper?: NonNullable<RobotArmRigMetadata['gripper']>;
  clips?: Array<{ name: string; durationSec: number; loop: boolean; description?: string; keys: GenericRigPoseKey[] }>;
};

export type ProfessionalRigImport = {
  joints: ImportedJointPose[];
  kinematicGraph: KinematicGraph;
  kinematicState: KinematicState;
  rigRootName: string;
  sourceSchema: string;
};

const DEG_TO_RAD = Math.PI / 180;
const EPSILON = 1e-8;

const id = (prefix: string, value: string) =>
  `${prefix}_${value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 56)}`;

const tuple = (vector: THREE.Vector3): Vector3Tuple => [vector.x, vector.y, vector.z];

const axisVector = (axis: RigAxis): Vector3Tuple => {
  if (axis === 'Y') return [0, 1, 0];
  if (axis === 'Z') return [0, 0, 1];
  return [1, 0, 0];
};

const axisKey = (axis: RigAxis): 'x' | 'y' | 'z' => axis.toLowerCase() as 'x' | 'y' | 'z';

const boundsFromObject = (object: THREE.Object3D) => {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  return {
    min: tuple(box.min),
    max: tuple(box.max),
    size: tuple(size),
    center: tuple(center),
  };
};

const findRigRoot = (scene: THREE.Object3D): { root: THREE.Object3D; metadata: RobotArmRigMetadata } | undefined => {
  let result: { root: THREE.Object3D; metadata: RobotArmRigMetadata } | undefined;
  scene.traverse((object) => {
    if (result) return;
    const metadata = object.userData as RobotArmRigMetadata;
    if (typeof metadata?.schema === 'string' && /^robot-arm-rig\/1\./i.test(metadata.schema) && Array.isArray(metadata.joints)) {
      result = { root: object, metadata };
    }
  });
  return result;
};

const findConveyorRoot = (scene: THREE.Object3D): { root: THREE.Object3D; metadata: Record<string, unknown> } | undefined => {
  let result: { root: THREE.Object3D; metadata: Record<string, unknown> } | undefined;
  scene.traverse((object) => {
    if (result) return;
    const metadata = object.userData as Record<string, unknown>;
    if (metadata?.schema === 'conveyor-rig/1.0' && Array.isArray(metadata.joints)) result = { root: object, metadata };
  });
  return result;
};

const objectMapByName = (scene: THREE.Object3D) => {
  const objects = new Map<string, THREE.Object3D>();
  scene.traverse((object) => {
    if (object.name && !objects.has(object.name)) objects.set(object.name, object);
  });
  return objects;
};

const nearestRigAncestor = (object: THREE.Object3D, rigNames: Set<string>, rigRoot: THREE.Object3D) => {
  let current = object.parent;
  while (current && current !== rigRoot.parent) {
    if (current.name && rigNames.has(current.name)) return current.name;
    if (current === rigRoot) return undefined;
    current = current.parent;
  }
  return undefined;
};

const parentAxisWorld = (object: THREE.Object3D, axis: RigAxis) => {
  const direction = new THREE.Vector3(...axisVector(axis));
  const parent = object.parent ?? object;
  parent.updateMatrixWorld(true);
  direction.transformDirection(parent.matrixWorld);
  return tuple(direction.normalize());
};

const jointWorldOrigin = (object: THREE.Object3D) => {
  const position = new THREE.Vector3();
  object.updateMatrixWorld(true);
  object.getWorldPosition(position);
  return tuple(position);
};

const localJointValue = (object: THREE.Object3D, metadata: RobotArmRigJointMetadata) => {
  const axis = axisKey(metadata.axis);
  if (metadata.type === 'prismatic') return object.position[axis];
  return object.rotation[axis];
};

const absoluteLimits = (metadata: RobotArmRigJointMetadata): [number, number] | undefined => {
  if (metadata.type === 'prismatic') return metadata.limitsMeters;
  if (metadata.limitsDeg) return [metadata.limitsDeg[0] * DEG_TO_RAD, metadata.limitsDeg[1] * DEG_TO_RAD];
  return undefined;
};

const absoluteHome = (metadata: RobotArmRigJointMetadata, rig: RobotArmRigMetadata, restValue: number) => {
  if (metadata.type === 'prismatic') {
    if (Number.isFinite(metadata.homeMeters)) return metadata.homeMeters as number;
    const gripper = rig.gripper;
    if (gripper && /finger_l$/i.test(metadata.name) && Number.isFinite(gripper.openMeters)) return -(gripper.openMeters as number);
    if (gripper && /finger_r$/i.test(metadata.name) && Number.isFinite(gripper.openMeters)) return gripper.openMeters as number;
    return restValue;
  }
  return Number.isFinite(metadata.homeDeg) ? (metadata.homeDeg as number) * DEG_TO_RAD : restValue;
};

const ROBOT_ARM_RIG_CLIPS: Array<{ name: string; durationSec: number; loop: boolean; description: string; keys: RobotArmPoseKey[] }> = [
  {
    name: 'Ciclo_Pick_And_Place',
    durationSec: 10,
    loop: true,
    description: 'Pick and place completo con cierre y apertura de pinza.',
    keys: [
      { t: 0, phase: 'home', J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
      { t: 1.5, phase: 'aproximacion', J1: -40, J2: 50, J3: 70, J4: 60, J5: 0, grip: 1 },
      { t: 2.6, phase: 'descenso', J1: -40, J2: 70, J3: 70, J4: 40, J5: 0, grip: 1 },
      { t: 3.3, phase: 'cierre', J1: -40, J2: 70, J3: 70, J4: 40, J5: 0, grip: 0 },
      { t: 4.2, phase: 'elevacion', J1: -40, J2: 50, J3: 70, J4: 60, J5: 0, grip: 0 },
      { t: 5.8, phase: 'transferencia', J1: 55, J2: 50, J3: 70, J4: 60, J5: 90, grip: 0 },
      { t: 6.9, phase: 'descenso destino', J1: 55, J2: 70, J3: 70, J4: 40, J5: 90, grip: 0 },
      { t: 7.6, phase: 'apertura', J1: 55, J2: 70, J3: 70, J4: 40, J5: 90, grip: 1 },
      { t: 8.5, phase: 'retirada', J1: 55, J2: 50, J3: 70, J4: 60, J5: 90, grip: 1 },
      { t: 10, phase: 'retorno home', J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
    ],
  },
  {
    name: 'Ir_A_Home',
    durationSec: 2,
    loop: false,
    description: 'Retorno suave a Home.',
    keys: [
      { t: 0, J1: 0, J2: 20, J3: 90, J4: 40, J5: 0, grip: 0 },
      { t: 2, J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
    ],
  },
  {
    name: 'Demo_Ejes',
    durationSec: 16.2,
    loop: true,
    description: 'Verifica los ejes J1-J5 en orden y la pinza al final.',
    keys: [
      { t: 0, J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
      { t: 1.6, J1: -170, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
      { t: 4, J1: 170, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
      { t: 5.4, J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
      { t: 6.6, J1: 0, J2: 95, J3: 60, J4: 60, J5: 0, grip: 1 },
      { t: 7.8, J1: 0, J2: -60, J3: 60, J4: 60, J5: 0, grip: 1 },
      { t: 8.8, J1: 0, J2: -10, J3: 150, J4: 60, J5: 0, grip: 1 },
      { t: 9.8, J1: 0, J2: -10, J3: -20, J4: 60, J5: 0, grip: 1 },
      { t: 10.8, J1: 0, J2: -10, J3: 60, J4: 110, J5: 0, grip: 1 },
      { t: 11.8, J1: 0, J2: -10, J3: 60, J4: -110, J5: 0, grip: 1 },
      { t: 12.8, J1: 0, J2: -10, J3: 60, J4: 60, J5: 180, grip: 1 },
      { t: 13.8, J1: 0, J2: -10, J3: 60, J4: 60, J5: -180, grip: 1 },
      { t: 14.6, J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
      { t: 15.4, J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 0 },
      { t: 16.2, J1: 0, J2: -10, J3: 60, J4: 60, J5: 0, grip: 1 },
    ],
  },
];

const COBOT_STATIC_SPEC: StaticRigSpec = {
  filePattern: /cobot-6dof\.obj$/i,
  assetName: 'cobot-6dof',
  rootName: 'CollaborativeArm6DOF',
  sourceSchema: 'robot-arm-rig/1.1-static-obj',
  analysisVersion: 'professional-rig-1.1-cobot-static-obj',
  rootPartName: 'BASE_fixed',
  parts: [
    { name: 'BASE_fixed', static: true, meshObjectIds: ['base_disc', 'base_pedestal', 'base_bolt_0', 'base_bolt_1', 'base_bolt_2', 'base_bolt_3'] },
    { name: 'J1_base_rotate', meshObjectIds: ['j1_shell', 'j1_seal'] },
    { name: 'J2_shoulder_lift', meshObjectIds: ['j2_drum_body', 'j2_drum_cap_0', 'j2_drum_cap_1', 'upper_arm_tube', 'upper_arm_knee'] },
    { name: 'J3_elbow', meshObjectIds: ['j3_drum_body', 'j3_drum_cap_0', 'j3_drum_cap_1', 'forearm_tube', 'forearm_knee'] },
    { name: 'J4_wrist_1', meshObjectIds: ['j4_drum_body', 'j4_drum_cap_0', 'j4_drum_cap_1', 'wrist_1_shell'] },
    { name: 'J5_wrist_2', meshObjectIds: ['j5_drum_body', 'j5_drum_cap_0', 'j5_drum_cap_1', 'wrist_2_shell'] },
    { name: 'J6_wrist_3', meshObjectIds: ['wrist_3_shell', 'tool_flange', 'flange_hole_0', 'flange_hole_1', 'flange_hole_2', 'flange_hole_3'] },
  ],
  joints: [
    { name: 'J1_base_rotate', order: 'J1', type: 'revolute', axis: 'Y', parent: 'BASE_fixed', originMeters: [0, 0.112, 0], limitsDeg: [-360, 360], homeDeg: 0, maxSpeedDegPerSec: 180 },
    { name: 'J2_shoulder_lift', order: 'J2', type: 'revolute', axis: 'Z', parent: 'J1_base_rotate', originMeters: [0, 0.19, 0], limitsDeg: [-175, 175], homeDeg: -35, maxSpeedDegPerSec: 180 },
    { name: 'J3_elbow', order: 'J3', type: 'revolute', axis: 'Z', parent: 'J2_shoulder_lift', originMeters: [0, 0.545, 0], limitsDeg: [-160, 160], homeDeg: 75, maxSpeedDegPerSec: 180 },
    { name: 'J4_wrist_1', order: 'J4', type: 'revolute', axis: 'Z', parent: 'J3_elbow', originMeters: [0, 0.85, 0], limitsDeg: [-175, 175], homeDeg: 50, maxSpeedDegPerSec: 225 },
    { name: 'J5_wrist_2', order: 'J5', type: 'revolute', axis: 'X', parent: 'J4_wrist_1', originMeters: [0, 0.922, 0], limitsDeg: [-175, 175], homeDeg: 0, maxSpeedDegPerSec: 225 },
    { name: 'J6_wrist_3', order: 'J6', type: 'revolute', axis: 'Y', parent: 'J5_wrist_2', originMeters: [0, 0.986, 0], limitsDeg: [-360, 360], homeDeg: 0, maxSpeedDegPerSec: 225 },
  ],
  clips: [
    {
      name: 'Ciclo_Asistencia',
      durationSec: 10,
      loop: true,
      description: 'Ciclo colaborativo de alimentacion de celda.',
      keys: [
        { t: 0, phase: 'home', J1: 0, J2: -35, J3: 75, J4: 50, J5: 0, J6: 0 },
        { t: 1.4, phase: 'aproximacion izquierda', J1: -55, J2: -10, J3: 85, J4: 25, J5: 0, J6: 0 },
        { t: 2.4, phase: 'toma', J1: -55, J2: 15, J3: 80, J4: -5, J5: 0, J6: 0 },
        { t: 3.2, phase: 'orienta herramienta', J1: -55, J2: 15, J3: 80, J4: -5, J5: 0, J6: 90 },
        { t: 5.6, phase: 'transferencia', J1: 50, J2: -10, J3: 85, J4: 25, J5: 0, J6: 90 },
        { t: 7.6, phase: 'presenta pieza', J1: 50, J2: 15, J3: 80, J4: -5, J5: 30, J6: -90 },
        { t: 10, phase: 'home', J1: 0, J2: -35, J3: 75, J4: 50, J5: 0, J6: 0 },
      ],
    },
    {
      name: 'Demo_Ejes',
      durationSec: 16.6,
      loop: true,
      description: 'Barrido profesional eje por eje J1 a J6.',
      keys: [
        { t: 0, J1: 0, J2: -35, J3: 75, J4: 50, J5: 0, J6: 0 },
        { t: 1.6, J1: -175, J2: -35, J3: 75, J4: 50, J5: 0, J6: 0 },
        { t: 4, J1: 175, J2: -35, J3: 75, J4: 50, J5: 0, J6: 0 },
        { t: 6.4, J1: 0, J2: -120, J3: 75, J4: 50, J5: 0, J6: 0 },
        { t: 8.4, J1: 0, J2: -35, J3: 150, J4: 50, J5: 0, J6: 0 },
        { t: 10.4, J1: 0, J2: -35, J3: 75, J4: 160, J5: 0, J6: 0 },
        { t: 12.4, J1: 0, J2: -35, J3: 75, J4: 50, J5: 160, J6: 0 },
        { t: 14.4, J1: 0, J2: -35, J3: 75, J4: 50, J5: 0, J6: 270 },
        { t: 16.6, J1: 0, J2: -35, J3: 75, J4: 50, J5: 0, J6: 0 },
      ],
    },
  ],
};

const CELL_INDUSTRIAL_STATIC_SPEC: StaticRigSpec = {
  filePattern: /industrial-arm-6dof\.obj$/i,
  assetName: 'industrial-arm-6dof',
  rootName: 'IndustrialArm6DOF',
  sourceSchema: 'robot-arm-rig/1.1-static-obj',
  analysisVersion: 'professional-rig-1.1-industrial-static-obj',
  rootPartName: 'BASE_fixed',
  parts: [
    { name: 'BASE_fixed', static: true, meshObjectIds: ['base_plate', 'base_pad_-1_-1', 'base_bolt_-1_-1', 'base_pad_-1_1', 'base_bolt_-1_1', 'base_pad_1_-1', 'base_bolt_1_-1', 'base_pad_1_1', 'base_bolt_1_1', 'base_pedestal', 'pedestal_ring'] },
    { name: 'J1_base_yaw', meshObjectIds: ['turret_body', 'shoulder_yoke', 'shoulder_bolt_0', 'shoulder_bolt_1', 'shoulder_bolt_2', 'shoulder_bolt_3'] },
    { name: 'J2_shoulder_pitch', meshObjectIds: ['upper_arm', 'upper_arm_web_0', 'upper_arm_web_1', 'upper_bolt_0_0', 'upper_bolt_0_1', 'upper_bolt_0_2', 'upper_bolt_0_3', 'upper_bolt_0_4', 'upper_bolt_1_0', 'upper_bolt_1_1', 'upper_bolt_1_2', 'upper_bolt_1_3', 'upper_bolt_1_4', 'j2_cap'] },
    { name: 'J3_elbow_pitch', meshObjectIds: ['j3_cap', 'forearm_lower'] },
    { name: 'J4_forearm_roll', meshObjectIds: ['j4_ring', 'forearm_upper', 'forearm_fin'] },
    { name: 'J5_wrist_pitch', meshObjectIds: ['wrist_yoke', 'wrist_body'] },
    { name: 'J6_tool_roll', meshObjectIds: ['tool_flange', 'gripper_housing', 'gripper_rail'] },
    { name: 'G1_finger_L', meshObjectIds: ['finger_carriage_L', 'finger_jaw_L', 'finger_tip_L', 'finger_pad_L'] },
    { name: 'G1_finger_R', meshObjectIds: ['finger_carriage_R', 'finger_jaw_R', 'finger_tip_R', 'finger_pad_R'] },
  ],
  joints: [
    { name: 'J1_base_yaw', order: 'J1', type: 'revolute', axis: 'Y', parent: 'BASE_fixed', originMeters: [0, 0.228, 0], limitsDeg: [-170, 170], homeDeg: 0, maxSpeedDegPerSec: 200 },
    { name: 'J2_shoulder_pitch', order: 'J2', type: 'revolute', axis: 'Z', parent: 'J1_base_yaw', originMeters: [0.01, 0.383, 0], limitsDeg: [-100, 80], homeDeg: -20, maxSpeedDegPerSec: 150 },
    { name: 'J3_elbow_pitch', order: 'J3', type: 'revolute', axis: 'Z', parent: 'J2_shoulder_pitch', originMeters: [-0.201, 0.746, 0], limitsDeg: [-60, 145], homeDeg: 70, maxSpeedDegPerSec: 170 },
    { name: 'J4_forearm_roll', order: 'J4', type: 'revolute', axis: 'Y', parent: 'J3_elbow_pitch', originMeters: [-0.396, 0.704, 0], limitsDeg: [-190, 190], homeDeg: 0, maxSpeedDegPerSec: 300 },
    { name: 'J5_wrist_pitch', order: 'J5', type: 'revolute', axis: 'Z', parent: 'J4_forearm_roll', originMeters: [-0.577, 0.664, 0], limitsDeg: [-120, 120], homeDeg: 40, maxSpeedDegPerSec: 300 },
    { name: 'J6_tool_roll', order: 'J6', type: 'revolute', axis: 'Y', parent: 'J5_wrist_pitch', originMeters: [-0.647, 0.624, 0], limitsDeg: [-360, 360], homeDeg: 0, maxSpeedDegPerSec: 420 },
    { name: 'G1_finger_L', order: 'G1', type: 'prismatic', axis: 'X', parent: 'J6_tool_roll', originMeters: [-0.688, 0.545, 0], limitsMeters: [-0.048, -0.014], homeMeters: -0.048, maxSpeedMetersPerSec: 0.15 },
    { name: 'G1_finger_R', order: 'G1', type: 'prismatic', axis: 'X', parent: 'J6_tool_roll', originMeters: [-0.736, 0.628, 0], limitsMeters: [0.014, 0.048], homeMeters: 0.048, maxSpeedMetersPerSec: 0.15 },
  ],
  gripper: { type: 'parallel_2_finger', axis: 'X', openMeters: 0.048, closedMeters: 0.014 },
  clips: [
    {
      name: 'Toma_De_Cinta',
      durationSec: 10,
      loop: true,
      description: 'Toma una pieza desde la cinta y la deposita en lateral.',
      keys: [
        { t: 0, J1: 0, J2: -20, J3: 70, J4: 0, J5: 40, J6: 0, grip: 1 },
        { t: 1.3, J1: 0, J2: 10, J3: 75, J4: 0, J5: 35, J6: 0, grip: 1 },
        { t: 2.3, J1: 0, J2: 32, J3: 72, J4: 0, J5: 16, J6: 0, grip: 1 },
        { t: 3.1, J1: 0, J2: 32, J3: 72, J4: 0, J5: 16, J6: 0, grip: 0 },
        { t: 5.6, J1: 95, J2: 10, J3: 75, J4: 90, J5: 35, J6: 0, grip: 0 },
        { t: 7.5, J1: 95, J2: 32, J3: 72, J4: 90, J5: 16, J6: 0, grip: 1 },
        { t: 10, J1: 0, J2: -20, J3: 70, J4: 0, J5: 40, J6: 0, grip: 1 },
      ],
    },
    {
      name: 'Demo_Ejes',
      durationSec: 17.6,
      loop: true,
      description: 'Barrido eje por eje J1 a J6 y pinza.',
      keys: [
        { t: 0, J1: 0, J2: -20, J3: 70, J4: 0, J5: 40, J6: 0, grip: 1 },
        { t: 1.6, J1: -170, J2: -20, J3: 70, J4: 0, J5: 40, J6: 0, grip: 1 },
        { t: 4, J1: 170, J2: -20, J3: 70, J4: 0, J5: 40, J6: 0, grip: 1 },
        { t: 6.4, J1: 0, J2: 80, J3: 70, J4: 0, J5: 40, J6: 0, grip: 1 },
        { t: 8.6, J1: 0, J2: -20, J3: 145, J4: 0, J5: 40, J6: 0, grip: 1 },
        { t: 10.6, J1: 0, J2: -20, J3: 70, J4: 190, J5: 40, J6: 0, grip: 1 },
        { t: 12.8, J1: 0, J2: -20, J3: 70, J4: 0, J5: 120, J6: 0, grip: 1 },
        { t: 14.8, J1: 0, J2: -20, J3: 70, J4: 0, J5: 40, J6: 360, grip: 1 },
        { t: 16.8, J1: 0, J2: -20, J3: 70, J4: 0, J5: 40, J6: 0, grip: 0 },
        { t: 17.6, J1: 0, J2: -20, J3: 70, J4: 0, J5: 40, J6: 0, grip: 1 },
      ],
    },
  ],
};

const CONVEYOR_STATIC_SPEC: StaticRigSpec = {
  filePattern: /conveyor-belt-2400\.obj$/i,
  assetName: 'conveyor-belt-2400',
  rootName: 'ConveyorBelt2400',
  sourceSchema: 'conveyor-rig/1.0-static-obj',
  analysisVersion: 'conveyor-rig-1-static-obj',
  rootPartName: 'FRAME_fixed',
  parts: [
    { name: 'FRAME_fixed', static: true, meshObjectIds: ['frame_beam_0', 'side_rail_0', 'frame_beam_1', 'side_rail_1', 'cross_member_0', 'cross_member_1', 'cross_member_2', 'cross_member_3', 'drum_head_0', 'drum_head_1', 'stopper_actuator'] },
    { name: 'R1_drive_roller', meshObjectIds: ['drive_roller_body', 'drive_roller_key'] },
    { name: 'R2_idler_roller', meshObjectIds: ['idler_roller_body', 'idler_roller_key'] },
    { name: 'BELT_surface', meshObjectIds: ['belt_top', 'belt_return', 'belt_wrap_0', 'belt_wrap_1'] },
    { name: 'S1_stopper', meshObjectIds: ['stopper_blade'] },
    { name: 'PARTS_optional', meshObjectIds: ['part_box_1', 'part_tape_1', 'part_box_2', 'part_tape_2', 'part_box_3', 'part_tape_3', 'part_box_4', 'part_tape_4'] },
  ],
  joints: [
    { name: 'R1_drive_roller', order: 'R1', type: 'continuous', axis: 'Z', parent: 'FRAME_fixed', originMeters: [1.19, 0.745, 0], homeDeg: 0 },
    { name: 'R2_idler_roller', order: 'R2', type: 'continuous', axis: 'Z', parent: 'FRAME_fixed', originMeters: [-1.19, 0.745, 0], homeDeg: 0 },
    { name: 'S1_stopper', order: 'S1', type: 'prismatic', axis: 'Y', parent: 'FRAME_fixed', originMeters: [0.78, 0.8, 0], limitsMeters: [-0.09, 0], homeMeters: -0.09, maxSpeedMetersPerSec: 0.36 },
  ],
  clips: [
    {
      name: 'Ciclo_Transporte',
      durationSec: 10,
      loop: true,
      description: 'Avance de cinta a 0.25 m/s con tope de estacion.',
      keys: [
        { t: 0, R1: 0, R2: 0, S1: -0.09 },
        { t: 1.2, R1: -5.45, R2: -5.45, S1: -0.09 },
        { t: 2.0, R1: -9.09, R2: -9.09, S1: 0 },
        { t: 5.4, R1: -24.55, R2: -24.55, S1: -0.09 },
        { t: 10, R1: -45.45, R2: -45.45, S1: -0.09 },
      ],
    },
  ],
};

const CELL_STATIC_RIG_SPECS = [COBOT_STATIC_SPEC, CELL_INDUSTRIAL_STATIC_SPEC, CONVEYOR_STATIC_SPEC];

const STATIC_OBJ_JOINTS: RobotArmRigJointMetadata[] = [
  { order: 'J1', name: 'J1_base_yaw', type: 'revolute', axis: 'Y', parent: 'BASE_fixed', originMeters: [0, 0.38, 0], limitsDeg: [-170, 170], homeDeg: 0, maxSpeedDegPerSec: 180 },
  { order: 'J2', name: 'J2_shoulder_pitch', type: 'revolute', axis: 'Z', parent: 'J1_base_yaw', originMeters: [0.02, 0.9, 0], limitsDeg: [-60, 95], homeDeg: -10, maxSpeedDegPerSec: 140 },
  { order: 'J3', name: 'J3_elbow_pitch', type: 'revolute', axis: 'Z', parent: 'J2_shoulder_pitch', originMeters: [0.02, 1.52, 0], limitsDeg: [-20, 150], homeDeg: 60, maxSpeedDegPerSec: 160 },
  { order: 'J4', name: 'J4_wrist_pitch', type: 'revolute', axis: 'Z', parent: 'J3_elbow_pitch', originMeters: [0.02, 1.98, 0], limitsDeg: [-110, 110], homeDeg: 60, maxSpeedDegPerSec: 250 },
  { order: 'J5', name: 'J5_tool_roll', type: 'revolute', axis: 'Y', parent: 'J4_wrist_pitch', originMeters: [0.02, 2.12, 0], limitsDeg: [-180, 180], homeDeg: 0, maxSpeedDegPerSec: 320 },
  { order: 'J6', name: 'J6_gripper_finger_L', type: 'prismatic', axis: 'X', parent: 'J5_tool_roll', originMeters: [-0.065, 2.24, 0], limitsMeters: [-0.085, -0.032], homeMeters: -0.085, maxSpeedMetersPerSec: 0.12 },
  { order: 'J6', name: 'J6_gripper_finger_R', type: 'prismatic', axis: 'X', parent: 'J5_tool_roll', originMeters: [0.105, 2.24, 0], limitsMeters: [0.032, 0.085], homeMeters: 0.085, maxSpeedMetersPerSec: 0.12 },
];

const STATIC_OBJ_MESH_IDS: Record<string, string[]> = {
  BASE_fixed: ['base_plate', 'base_pedestal', 'base_bolt_0', 'base_bolt_1', 'base_bolt_2', 'base_bolt_3', 'base_bolt_4', 'base_bolt_5', 'base_bolt_6', 'base_bolt_7', 'cable_conduit'],
  J1_base_yaw: ['turret_body', 'turret_collar', 'shoulder_housing'],
  J2_shoulder_pitch: ['shoulder_axle', 'upper_arm', 'upper_arm_rib', 'upper_arm_stripe'],
  J3_elbow_pitch: ['elbow_axle', 'forearm', 'forearm_motor_housing'],
  J4_wrist_pitch: ['wrist_ball', 'wrist_link'],
  J5_tool_roll: ['tool_flange', 'gripper_body'],
  J6_gripper_finger_L: ['gripper_finger_L', 'gripper_pad_L'],
  J6_gripper_finger_R: ['gripper_finger_R', 'gripper_pad_R'],
};

const STATIC_OBJ_MATERIALS: Record<string, { color: number; roughness: number; metalness: number }> = {
  steel_housing: { color: 0x454b52, roughness: 0.5, metalness: 0.4 },
  safety_orange: { color: 0xd9520c, roughness: 0.42, metalness: 0.18 },
  chrome_joint: { color: 0xcfd2d6, roughness: 0.22, metalness: 0.8 },
  cable_rubber: { color: 0x1b1c1e, roughness: 0.85, metalness: 0.05 },
  warning_yellow: { color: 0xe8b400, roughness: 0.5, metalness: 0.1 },
};

const STATIC_OBJ_MATERIAL_BY_MESH: Record<string, keyof typeof STATIC_OBJ_MATERIALS> = {
  base_plate: 'steel_housing',
  base_pedestal: 'safety_orange',
  cable_conduit: 'cable_rubber',
  turret_body: 'steel_housing',
  turret_collar: 'chrome_joint',
  shoulder_housing: 'safety_orange',
  shoulder_axle: 'chrome_joint',
  upper_arm: 'safety_orange',
  upper_arm_rib: 'steel_housing',
  upper_arm_stripe: 'warning_yellow',
  elbow_axle: 'chrome_joint',
  forearm: 'safety_orange',
  forearm_motor_housing: 'steel_housing',
  wrist_ball: 'chrome_joint',
  wrist_link: 'steel_housing',
  tool_flange: 'chrome_joint',
  gripper_body: 'steel_housing',
  gripper_finger_L: 'steel_housing',
  gripper_pad_L: 'cable_rubber',
  gripper_finger_R: 'steel_housing',
  gripper_pad_R: 'cable_rubber',
};

for (let index = 0; index < 8; index += 1) {
  STATIC_OBJ_MATERIAL_BY_MESH[`base_bolt_${index}`] = 'chrome_joint';
}

const makePart = (partId: string, name: string, object: THREE.Object3D | undefined, staticPart: boolean, sourceSchema: string): MechanicalPart => ({
  id: partId,
  name,
  meshObjectIds: object?.name ? [object.name] : [],
  localFrame: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  bounds: object
    ? boundsFromObject(object)
    : {
        min: [0, 0, 0],
        max: [0, 0, 0],
        size: [0, 0, 0],
        center: [0, 0, 0],
      },
  static: staticPart,
  visible: true,
  source: 'imported',
  metadata: {
    sourceSchema,
    professionalRig: true,
  },
});

const makeStaticObjMaterial = (name: keyof typeof STATIC_OBJ_MATERIALS) => {
  const spec = STATIC_OBJ_MATERIALS[name];
  return new THREE.MeshStandardMaterial({
    name,
    color: spec.color,
    roughness: spec.roughness,
    metalness: spec.metalness,
  });
};

export const applyStaticObjRobotMaterials = (scene: THREE.Object3D) => {
  const materialCache = new Map<string, THREE.MeshStandardMaterial>();
  const materialFor = (name: keyof typeof STATIC_OBJ_MATERIALS) => {
    const cached = materialCache.get(name);
    if (cached) return cached;
    const material = makeStaticObjMaterial(name);
    materialCache.set(name, material);
    return material;
  };

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materialName =
      STATIC_OBJ_MATERIAL_BY_MESH[mesh.name] ??
      (/bolt|axle|collar|ball|flange/i.test(mesh.name)
        ? 'chrome_joint'
        : /upper_arm|forearm|pedestal|shoulder_housing/i.test(mesh.name)
          ? 'safety_orange'
          : /pad|cable/i.test(mesh.name)
            ? 'cable_rubber'
            : /stripe/i.test(mesh.name)
              ? 'warning_yellow'
              : 'steel_housing');
    mesh.material = materialFor(materialName);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
};

const cellMaterialSpec = (meshName: string, fileName: string): { color: number; roughness: number; metalness: number } | undefined => {
  if (/cobot-6dof\.obj$/i.test(fileName)) {
    if (/base_|j\d_.*(?:body|cap|seal|drum)|wrist_3/i.test(meshName)) return { color: 0x2b2d31, roughness: 0.46, metalness: 0.22 };
    if (/flange|hole|bolt/i.test(meshName)) return { color: 0xb9bcc0, roughness: 0.3, metalness: 0.7 };
    return { color: 0xe2650d, roughness: 0.38, metalness: 0.12 };
  }
  if (/industrial-arm-6dof\.obj$/i.test(fileName)) {
    if (/bolt|ring|flange|rail|carriage/i.test(meshName)) return { color: 0xb4b8bc, roughness: 0.28, metalness: 0.72 };
    if (/pad/i.test(meshName)) return { color: 0x1b1c1e, roughness: 0.88, metalness: 0.04 };
    if (/shade|web|cap|yoke|tip/i.test(meshName)) return { color: 0xdedcd8, roughness: 0.5, metalness: 0.08 };
    return { color: 0xf2f1ef, roughness: 0.42, metalness: 0.08 };
  }
  if (/conveyor-belt-2400\.obj$/i.test(fileName)) {
    if (/belt/i.test(meshName)) return { color: 0x3b3d40, roughness: 0.82, metalness: 0.04 };
    if (/part_/i.test(meshName)) return { color: 0xc8a06a, roughness: 0.72, metalness: 0.02 };
    if (/bolt|nut|roller|key/i.test(meshName)) return { color: 0x8f9397, roughness: 0.3, metalness: 0.85 };
    return { color: 0xd2d5d8, roughness: 0.32, metalness: 0.68 };
  }
  return undefined;
};

export const applyCellStaticRigMaterials = (scene: THREE.Object3D, fileName: string) => {
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const spec = cellMaterialSpec(mesh.name, fileName);
    if (!spec) return;
    mesh.material = new THREE.MeshStandardMaterial({
      name: `${fileName.replace(/\W+/g, '_')}_${mesh.name}`,
      color: spec.color,
      roughness: spec.roughness,
      metalness: spec.metalness,
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
};

const jointTypeFromMetadata = (metadata: RobotArmRigJointMetadata): KinematicJoint['type'] =>
  metadata.type === 'continuous' ? 'continuous' : metadata.type === 'prismatic' ? 'prismatic' : metadata.type === 'fixed' ? 'fixed' : 'revolute';

const restValueFromMetadata = (metadata: RobotArmRigJointMetadata) => {
  if (metadata.type === 'prismatic') return metadata.homeMeters ?? 0;
  return Number.isFinite(metadata.homeDeg) ? (metadata.homeDeg as number) * DEG_TO_RAD : 0;
};

const limitsRelativeToRest = (metadata: RobotArmRigJointMetadata, restValue: number) => {
  const absolute = absoluteLimits(metadata);
  if (!absolute) return undefined;
  return {
    lower: Math.min(absolute[0] - restValue, absolute[1] - restValue),
    upper: Math.max(absolute[0] - restValue, absolute[1] - restValue),
    velocity: metadata.type === 'prismatic' ? metadata.maxSpeedMetersPerSec : metadata.maxSpeedDegPerSec ? metadata.maxSpeedDegPerSec * DEG_TO_RAD : undefined,
  };
};

const valueForGenericKey = (
  joint: KinematicJoint,
  key: GenericRigPoseKey,
  restValueByJointId: Map<string, number>,
  gripper?: NonNullable<RobotArmRigMetadata['gripper']>,
) => {
  const order = joint.evidence[0]?.metadata?.order;
  const restValue = restValueByJointId.get(joint.id) ?? 0;
  if (typeof order === 'string' && order !== 'G1') {
    const raw = key[order];
    if (!Number.isFinite(raw)) return undefined;
    return joint.type === 'prismatic' ? (raw as number) - restValue : (raw as number) * DEG_TO_RAD - restValue;
  }
  if (order === 'G1' && Number.isFinite(key.grip)) {
    const open = gripper?.openMeters ?? 0.048;
    const closed = gripper?.closedMeters ?? 0.014;
    const x = closed + (open - closed) * (key.grip as number);
    const absolute = /finger_l$/i.test(joint.name) ? -x : x;
    return absolute - restValue;
  }
  return undefined;
};

const motionClipsFromPoseKeys = (
  joints: KinematicJoint[],
  restValueByJointId: Map<string, number>,
  clips: NonNullable<StaticRigSpec['clips']>,
  gripper?: NonNullable<RobotArmRigMetadata['gripper']>,
): KinematicMotionClip[] =>
  clips.map((clip) => ({
    id: id('clip', clip.name),
    name: clip.name,
    duration: clip.durationSec,
    loop: clip.loop,
    source: 'imported',
    description: clip.description,
    keyframes: clip.keys.map((key) => ({
      time: key.t,
      label: typeof key.phase === 'string' ? key.phase : undefined,
      jointValues: Object.fromEntries(
        joints
          .map((joint) => [joint.id, valueForGenericKey(joint, key, restValueByJointId, gripper)] as const)
          .filter((entry): entry is readonly [string, number] => Number.isFinite(entry[1])),
      ),
    })),
  }));

const trackNodeName = (trackName: string) => trackName.replace(/\.(quaternion|rotation|position|scale)(\[[^\]]+\])?$/i, '');

const localAxisValue = (axis: RigAxis, values: ArrayLike<number>, offset: number, type: 'quaternion' | 'position') => {
  if (type === 'position') {
    if (axis === 'Y') return values[offset + 1] ?? 0;
    if (axis === 'Z') return values[offset + 2] ?? 0;
    return values[offset] ?? 0;
  }
  const component = axis === 'Y' ? (values[offset + 1] ?? 0) : axis === 'Z' ? (values[offset + 2] ?? 0) : (values[offset] ?? 0);
  const w = values[offset + 3] ?? 1;
  return 2 * Math.atan2(component, w);
};

const motionClipsFromThreeAnimations = (
  animations: THREE.AnimationClip[] | undefined,
  joints: KinematicJoint[],
  restValueByJointId: Map<string, number>,
  metadataClips?: RobotArmRigMetadata['clips'],
): KinematicMotionClip[] | undefined => {
  if (!animations?.length) return undefined;
  const jointByName = new Map(joints.map((joint) => [joint.name, joint]));
  const metadataByName = new Map((metadataClips ?? []).map((clip) => [clip.name, clip]));

  return animations
    .flatMap((animation): KinematicMotionClip[] => {
      const keyframes = new Map<number, Record<string, number>>();
      animation.tracks.forEach((track) => {
        const joint = jointByName.get(trackNodeName(track.name));
        if (!joint) return;
        const rigAxis = (joint.evidence[0]?.metadata?.rigAxis as RigAxis | undefined) ?? 'X';
        const restValue = restValueByJointId.get(joint.id) ?? 0;
        const valueSize = track.getValueSize();
        const type = /quaternion/i.test(track.ValueTypeName) ? 'quaternion' : /vector/i.test(track.ValueTypeName) ? 'position' : undefined;
        if (!type) return;
        track.times.forEach((time, index) => {
          const value = localAxisValue(rigAxis, track.values, index * valueSize, type) - restValue;
          const roundedTime = Number(time.toFixed(4));
          keyframes.set(roundedTime, { ...(keyframes.get(roundedTime) ?? {}), [joint.id]: value });
        });
      });
      const metadata = metadataByName.get(animation.name);
      const sortedKeyframes = [...keyframes.entries()]
        .sort(([a], [b]) => a - b)
        .map(([time, jointValues]) => ({ time, jointValues }));
      return sortedKeyframes.length
        ? [
            {
            id: id('clip', animation.name),
            name: animation.name,
            duration: metadata?.durationSec ?? animation.duration,
            loop: metadata?.loop ?? true,
            source: 'imported' as const,
            keyframes: sortedKeyframes,
            },
          ]
        : [];
    });
};

const buildStaticRig = (scene: THREE.Object3D, spec: StaticRigSpec): ProfessionalRigImport | undefined => {
  scene.updateMatrixWorld(true);
  const objects = objectMapByName(scene);
  const hasAnyPartMesh = spec.parts.some((part) => part.meshObjectIds.some((name) => objects.has(name)));
  if (!hasAnyPartMesh) return undefined;

  const rootPartId = id('part', spec.rootPartName);
  const partIdByName = new Map<string, string>([[spec.rootPartName, rootPartId]]);
  const parts: MechanicalPart[] = spec.parts.map((part) => {
    const partId = part.name === spec.rootPartName ? rootPartId : id('part', part.name);
    partIdByName.set(part.name, partId);
    return makeStaticObjPart(partId, part.name, part.meshObjectIds, objects, Boolean(part.static), spec.sourceSchema);
  });

  const importedJoints: ImportedJointPose[] = [];
  const joints: KinematicJoint[] = [];
  const homeJointValues: Record<string, number> = {};
  const restValueByJointId = new Map<string, number>();

  spec.joints.forEach((metadata) => {
    const childPartId = partIdByName.get(metadata.name);
    const parentPartId = partIdByName.get(metadata.parent ?? spec.rootPartName) ?? rootPartId;
    const origin = metadata.originMeters;
    const axis = normalizeAxis(metadata.axisVector ?? axisVector(metadata.axis));
    if (!childPartId || !origin || !axis) return;
    const frame = createJointFrame(origin, axis, 'imported', {
      primitive: metadata.type === 'prismatic' ? 'plane' : 'cylinder',
      evidenceLevel: 'high',
      messages: ['Recovered from documented cell rig metadata. Static OBJ geometry remains unchanged.'],
    }, 'accepted');
    if (!frame) return;

    const restValue = restValueFromMetadata(metadata);
    const limits = limitsRelativeToRest(metadata, restValue);
    const jointId = id('joint', metadata.name);
    homeJointValues[jointId] = 0;
    restValueByJointId.set(jointId, restValue);
    importedJoints.push({
      name: metadata.name,
      label: metadata.name.replace(/_/g, ' '),
      sourceType: 'object',
      motionKind: metadata.type === 'prismatic' ? 'translation' : 'rotation',
      axis: axisKey(metadata.axis),
      cursorControl: metadata.type === 'prismatic' ? 'linear-axis' : metadata.axis === 'Y' ? 'horizontal-rotation' : 'vertical-rotation',
      min: limits?.lower,
      max: limits?.upper,
      demoAmplitude: metadata.type === 'prismatic' ? Math.min(Math.abs(limits?.upper ?? 0.05), 0.06) : Math.min(Math.abs(limits?.upper ?? 0.8), 0.9),
      rotation: [0, 0, 0],
      translation: [0, 0, 0],
    });
    joints.push({
      id: jointId,
      name: metadata.name,
      parentPartId,
      childPartId,
      type: jointTypeFromMetadata(metadata),
      origin: { position: origin, rotation: frame.orientation },
      axis,
      jointFrame: frame,
      limits,
      source: 'imported',
      confidence: 0.97,
      evidence: [
        {
          type: 'imported-hierarchy',
          score: 0.97,
          message: `Documented cell rig joint ${metadata.name}: ${metadata.type} ${metadata.axis}.`,
          metadata: {
            sourceSchema: spec.sourceSchema,
            order: metadata.order,
            rigAxis: metadata.axis,
            axisVector: metadata.axisVector,
            useJointAxisVector: Boolean(metadata.axisVector),
            morphology: metadata.morphology,
            pivotObjectName: metadata.pivotObjectName,
            absoluteLimits: absoluteLimits(metadata),
            absoluteHome: restValue,
            restValue,
            units: metadata.type === 'prismatic' ? 'meters' : 'radians',
          },
        },
      ],
      status: 'validated',
    });
  });

  const left = joints.find((joint) => /finger_l$/i.test(joint.name));
  const right = joints.find((joint) => /finger_r$/i.test(joint.name));
  if (left && right) right.coupling = { driverJointId: left.id, multiplier: -1, offset: 0 };

  return {
    joints: importedJoints,
    kinematicGraph: {
      rootPartId,
      parts,
      joints,
      logicalControls:
        left && right
          ? [
              {
                id: 'control_gripper_opening',
                name: 'Parallel gripper opening',
                jointMappings: [
                  { jointId: left.id, multiplier: 1, offset: 0 },
                  { jointId: right.id, multiplier: -1, offset: 0 },
                ],
              },
            ]
          : undefined,
      motionClips: spec.clips ? motionClipsFromPoseKeys(joints, restValueByJointId, spec.clips, spec.gripper) : undefined,
      analysisVersion: spec.analysisVersion,
    },
    kinematicState: { homeJointValues, jointValues: { ...homeJointValues } },
    rigRootName: spec.rootName,
    sourceSchema: spec.sourceSchema,
  };
};

const boundsFromObjects = (objects: THREE.Object3D[]) => {
  const box = new THREE.Box3();
  objects.forEach((object) => {
    object.updateMatrixWorld(true);
    box.expandByObject(object);
  });
  if (box.isEmpty()) {
    return {
      min: [0, 0, 0] as Vector3Tuple,
      max: [0, 0, 0] as Vector3Tuple,
      size: [0, 0, 0] as Vector3Tuple,
      center: [0, 0, 0] as Vector3Tuple,
    };
  }
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  return {
    min: tuple(box.min),
    max: tuple(box.max),
    size: tuple(size),
    center: tuple(center),
  };
};

const centerOfObject = (objects: Map<string, THREE.Object3D>, name: string): Vector3Tuple | undefined => {
  const object = objects.get(name);
  if (!object) return undefined;
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return undefined;
  const center = new THREE.Vector3();
  box.getCenter(center);
  return tuple(center);
};

const namesMatching = (objects: Map<string, THREE.Object3D>, patterns: RegExp[]) =>
  [...objects.keys()].filter((name) => patterns.some((pattern) => pattern.test(name)));

const firstNameMatching = (objects: Map<string, THREE.Object3D>, patterns: RegExp[]) => namesMatching(objects, patterns)[0];

const jointsWithOrigin = (...joints: RobotArmRigJointMetadata[]) => joints.filter((joint) => Boolean(joint.originMeters));

const distanceBetween = (a: Vector3Tuple, b: Vector3Tuple) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

type ShapeAxisCandidate = {
  origin: Vector3Tuple;
  axis: Vector3Tuple;
  rigAxis: RigAxis;
  score: number;
  sourceObjectNames: string[];
};

const boundsFromObjectNames = (objects: Map<string, THREE.Object3D>, names: Array<string | undefined>) => {
  const selected = names.map((name) => (name ? objects.get(name) : undefined)).filter((object): object is THREE.Object3D => Boolean(object));
  return selected.length ? boundsFromObjects(selected) : undefined;
};

const intervalJoinPoint = (aMin: number, aMax: number, bMin: number, bMax: number) => {
  const overlapMin = Math.max(aMin, bMin);
  const overlapMax = Math.min(aMax, bMax);
  if (overlapMin <= overlapMax) return (overlapMin + overlapMax) / 2;
  return aMax < bMin ? (aMax + bMin) / 2 : (bMax + aMin) / 2;
};

const jointOriginBetweenParts = (
  objects: Map<string, THREE.Object3D>,
  parentNames: Array<string | undefined>,
  childNames: Array<string | undefined>,
  fallbackName?: string,
): Vector3Tuple | undefined => {
  const parent = boundsFromObjectNames(objects, parentNames);
  const child = boundsFromObjectNames(objects, childNames);
  if (!parent || !child) return fallbackName ? centerOfObject(objects, fallbackName) : undefined;
  return [
    intervalJoinPoint(parent.min[0], parent.max[0], child.min[0], child.max[0]),
    intervalJoinPoint(parent.min[1], parent.max[1], child.min[1], child.max[1]),
    intervalJoinPoint(parent.min[2], parent.max[2], child.min[2], child.max[2]),
  ];
};

const addMatrix = (target: number[][], vector: Vector3Tuple, weight: number) => {
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) target[row][col] += vector[row] * vector[col] * weight;
  }
};

const multiplyMatrixVector = (matrix: number[][], vector: Vector3Tuple): Vector3Tuple => [
  matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
  matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
  matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2],
];

const subtractOuterProduct = (matrix: number[][], axis: Vector3Tuple, eigenvalue: number) =>
  matrix.map((row, rowIndex) => row.map((value, colIndex) => value - axis[rowIndex] * axis[colIndex] * eigenvalue));

const principalAxisFromMatrix = (matrix: number[][], initial: Vector3Tuple) => {
  let axis = normalizedVector(initial, [1, 0, 0]);
  for (let index = 0; index < 42; index += 1) {
    const next = normalizedVector(multiplyMatrixVector(matrix, axis), axis);
    if (Math.abs(dotVector(axis, next)) > 1 - 1e-8) return next;
    axis = next;
  }
  return axis;
};

const sampledWorldVertices = (object: THREE.Object3D, maxVertices = 9000): THREE.Vector3[] => {
  const vertices: THREE.Vector3[] = [];
  object.updateMatrixWorld(true);
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    const position = geometry?.getAttribute('position');
    if (!mesh.isMesh || !position) return;
    const remaining = Math.max(maxVertices - vertices.length, 0);
    if (!remaining) return;
    const step = Math.max(1, Math.ceil(position.count / Math.max(remaining, 1)));
    for (let index = 0; index < position.count && vertices.length < maxVertices; index += step) {
      vertices.push(new THREE.Vector3(position.getX(index), position.getY(index), position.getZ(index)).applyMatrix4(mesh.matrixWorld));
    }
  });
  return vertices;
};

const closestRigAxis = (axis: Vector3Tuple): RigAxis => {
  const absolute = axis.map((value) => Math.abs(value));
  const index = absolute.indexOf(Math.max(...absolute));
  return index === 1 ? 'Y' : index === 2 ? 'Z' : 'X';
};

const alignAxisToFallback = (axis: Vector3Tuple, fallback: Vector3Tuple) => (dotVector(axis, fallback) < 0 ? ([-axis[0], -axis[1], -axis[2]] as Vector3Tuple) : axis);

const roundedAxisFromObjects = (
  objects: Map<string, THREE.Object3D>,
  names: Array<string | undefined>,
  fallbackAxis: RigAxis,
): ShapeAxisCandidate | undefined => {
  const selected = names.map((name) => (name ? objects.get(name) : undefined)).filter((object): object is THREE.Object3D => Boolean(object));
  if (!selected.length) return undefined;
  const points = selected.flatMap((object) => sampledWorldVertices(object, Math.max(1800, Math.floor(9000 / selected.length))));
  if (points.length < 24) return undefined;
  const bounds = boundsFromObjects(selected);
  const center = new THREE.Vector3(...bounds.center);
  const covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  points.forEach((point) => addMatrix(covariance, tuple(point.clone().sub(center)), 1 / points.length));
  const firstAxis = principalAxisFromMatrix(covariance, [0.731, 0.521, 0.439]);
  const firstValue = dotVector(firstAxis, multiplyMatrixVector(covariance, firstAxis));
  const secondMatrix = subtractOuterProduct(covariance, firstAxis, firstValue);
  const secondAxis = principalAxisFromMatrix(secondMatrix, [0.127, 0.883, 0.451]);
  const secondValue = dotVector(secondAxis, multiplyMatrixVector(covariance, secondAxis));
  const thirdAxis = normalizedVector(crossVector(firstAxis, secondAxis), [0, 0, 1]);
  const thirdValue = dotVector(thirdAxis, multiplyMatrixVector(covariance, thirdAxis));
  const axes = [
    { axis: firstAxis, spread: Math.sqrt(Math.max(firstValue, 0)) },
    { axis: secondAxis, spread: Math.sqrt(Math.max(secondValue, 0)) },
    { axis: thirdAxis, spread: Math.sqrt(Math.max(thirdValue, 0)) },
  ].sort((a, b) => b.spread - a.spread);
  const longRoundness = Math.abs(axes[1].spread - axes[2].spread) / Math.max(axes[1].spread, EPSILON);
  const diskRoundness = Math.abs(axes[0].spread - axes[1].spread) / Math.max(axes[0].spread, EPSILON);
  const longCylinder = longRoundness <= 0.25 && axes[0].spread >= axes[1].spread * 1.22;
  const diskCylinder = diskRoundness <= 0.25 && axes[1].spread >= axes[2].spread * 1.22;
  const candidate = longCylinder ? axes[0] : diskCylinder ? axes[2] : undefined;
  if (!candidate) return undefined;
  const axis = alignAxisToFallback(normalizedVector(candidate.axis, axisVector(fallbackAxis)), axisVector(fallbackAxis));
  return {
    origin: tuple(center),
    axis,
    rigAxis: closestRigAxis(axis),
    score: 1 - Math.min(longCylinder ? longRoundness : diskRoundness, 1),
    sourceObjectNames: selected.map((object) => object.name),
  };
};

const radialBoundsAxisFromObjects = (
  objects: Map<string, THREE.Object3D>,
  names: Array<string | undefined>,
  axis: RigAxis,
): ShapeAxisCandidate | undefined => {
  const selected = names.map((name) => (name ? objects.get(name) : undefined)).filter((object): object is THREE.Object3D => Boolean(object));
  if (!selected.length) return undefined;
  const bounds = boundsFromObjects(selected);
  const size = bounds.size;
  const radial =
    axis === 'Y'
      ? [size[0], size[2]]
      : axis === 'Z'
        ? [size[0], size[1]]
        : [size[1], size[2]];
  const radialRoundness = Math.abs(radial[0] - radial[1]) / Math.max(radial[0], radial[1], EPSILON);
  if (radialRoundness > 0.18) return undefined;
  return {
    origin: bounds.center,
    axis: axisVector(axis),
    rigAxis: axis,
    score: 1 - radialRoundness,
    sourceObjectNames: selected.map((object) => object.name),
  };
};

const jointMetadata = (
  metadata: Omit<RobotArmRigJointMetadata, 'axis'> & { axis: RigAxis; shape?: ShapeAxisCandidate; fallbackOrigin?: Vector3Tuple },
): RobotArmRigJointMetadata => ({
  ...metadata,
  axis: metadata.shape?.rigAxis ?? metadata.axis,
  axisVector: metadata.shape?.axis,
  originMeters: metadata.shape?.origin ?? metadata.originMeters ?? metadata.fallbackOrigin,
  morphology: metadata.shape
    ? { method: 'rounded-body', score: metadata.shape.score, sourceObjectNames: metadata.shape.sourceObjectNames }
    : metadata.originMeters || metadata.fallbackOrigin
      ? { method: 'contact' }
      : undefined,
});

const vectorFrom = (a: Vector3Tuple | undefined, b: Vector3Tuple | undefined): Vector3Tuple | undefined =>
  a && b ? [a[0] - b[0], a[1] - b[1], a[2] - b[2]] : undefined;

const vectorLength = (value: Vector3Tuple | undefined) => (value ? Math.hypot(value[0], value[1], value[2]) : 0);

const normalizedVector = (value: Vector3Tuple | undefined, fallback: Vector3Tuple): Vector3Tuple => {
  const length = vectorLength(value);
  return length > EPSILON && value ? [value[0] / length, value[1] / length, value[2] / length] : fallback;
};

const crossVector = (a: Vector3Tuple, b: Vector3Tuple): Vector3Tuple => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const dotVector = (a: Vector3Tuple, b: Vector3Tuple) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const signedAngleAroundAxis = (fromInput: Vector3Tuple, toInput: Vector3Tuple | undefined, axisInput: Vector3Tuple) => {
  const from = normalizedVector(fromInput, [0, 1, 0]);
  const to = normalizedVector(toInput, from);
  const axis = normalizedVector(axisInput, [0, 0, 1]);
  const sin = dotVector(axis, crossVector(from, to));
  const cos = Math.max(-1, Math.min(1, dotVector(from, to)));
  return Math.atan2(sin, cos);
};

const inferStaticObjRigFrame = (objects: Map<string, THREE.Object3D>) => {
  const base = centerOfObject(objects, 'turret_collar') ?? ([0, 0.38, 0] as Vector3Tuple);
  const shoulder = centerOfObject(objects, 'shoulder_axle') ?? ([0.02, 0.9, 0] as Vector3Tuple);
  const elbow = centerOfObject(objects, 'elbow_axle') ?? ([0.02, 1.52, 0] as Vector3Tuple);
  const wrist = centerOfObject(objects, 'wrist_ball') ?? ([0.02, 1.98, 0] as Vector3Tuple);
  const tool = centerOfObject(objects, 'tool_flange') ?? centerOfObject(objects, 'gripper_body') ?? ([0.02, 2.12, 0] as Vector3Tuple);
  const leftFinger = centerOfObject(objects, 'gripper_finger_L') ?? ([-0.065, 2.24, 0] as Vector3Tuple);
  const rightFinger = centerOfObject(objects, 'gripper_finger_R') ?? ([0.105, 2.24, 0] as Vector3Tuple);
  const upperVector = vectorFrom(elbow, shoulder);
  const forearmVector = vectorFrom(wrist, elbow);
  const wristVector = vectorFrom(tool, wrist);
  const pitchAxis = normalizedVector(crossVector(normalizedVector(upperVector, [0, 1, 0]), normalizedVector(forearmVector, [1, 0, 0])), [0, 0, 1]);
  const gripperAxis = normalizedVector(vectorFrom(rightFinger, leftFinger), [1, 0, 0]);
  const toolAxis = normalizedVector(wristVector, [0, 1, 0]);
  const upperAngle = signedAngleAroundAxis([0, 1, 0], upperVector, pitchAxis);
  const forearmAngle = signedAngleAroundAxis([0, 1, 0], forearmVector, pitchAxis);
  const wristAngle = signedAngleAroundAxis([0, 1, 0], wristVector, pitchAxis);

  return {
    origins: {
      J1_base_yaw: base,
      J2_shoulder_pitch: shoulder,
      J3_elbow_pitch: elbow,
      J4_wrist_pitch: wrist,
      J5_tool_roll: tool,
      J6_gripper_finger_L: leftFinger,
      J6_gripper_finger_R: rightFinger,
    } as Record<string, Vector3Tuple>,
    axes: {
      J1_base_yaw: [0, 1, 0] as Vector3Tuple,
      J2_shoulder_pitch: pitchAxis,
      J3_elbow_pitch: pitchAxis,
      J4_wrist_pitch: pitchAxis,
      J5_tool_roll: toolAxis,
      J6_gripper_finger_L: gripperAxis,
      J6_gripper_finger_R: gripperAxis,
    } as Record<string, Vector3Tuple>,
    restValues: {
      J1_base_yaw: Math.atan2(pitchAxis[0], pitchAxis[2]),
      J2_shoulder_pitch: upperAngle,
      J3_elbow_pitch: forearmAngle - upperAngle,
      J4_wrist_pitch: wristAngle - forearmAngle,
      J5_tool_roll: 0,
      J6_gripper_finger_L: 0,
      J6_gripper_finger_R: 0,
    } as Record<string, number>,
  };
};

const makeStaticObjPart = (partId: string, name: string, meshObjectIds: string[], objects: Map<string, THREE.Object3D>, staticPart: boolean, sourceSchema: string): MechanicalPart => {
  const meshObjects = meshObjectIds.map((meshName) => objects.get(meshName)).filter((object): object is THREE.Object3D => Boolean(object));
  return {
    id: partId,
    name,
    meshObjectIds: meshObjects.map((object) => object.name),
    localFrame: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    bounds: boundsFromObjects(meshObjects),
    static: staticPart,
    visible: true,
    source: 'imported',
    metadata: {
      sourceSchema,
      professionalRig: true,
      recoveredFromStaticObj: true,
    },
  };
};

const staticObjMotionClips = (joints: KinematicJoint[], restValueByJointId: Map<string, number>, gripper: NonNullable<RobotArmRigMetadata['gripper']>): KinematicMotionClip[] => {
  const valueForKey = (joint: KinematicJoint, key: RobotArmPoseKey) => {
    const order = joint.evidence[0]?.metadata?.order;
    const restValue = restValueByJointId.get(joint.id) ?? 0;
    if (typeof order === 'string' && order !== 'J6') {
      const value = key[order as keyof RobotArmPoseKey];
      return Number.isFinite(value) ? (value as number) * DEG_TO_RAD - restValue : undefined;
    }
    if (order === 'J6' && Number.isFinite(key.grip)) {
      const open = gripper.openMeters ?? 0.085;
      const closed = gripper.closedMeters ?? 0.032;
      const travel = open - closed;
      const closeValue = travel * (1 - (key.grip as number));
      return /finger_l$/i.test(joint.name) ? closeValue : -closeValue;
    }
    return undefined;
  };

  return ROBOT_ARM_RIG_CLIPS.map((clip) => ({
    id: id('clip', clip.name),
    name: clip.name,
    duration: clip.durationSec,
    loop: clip.loop,
    source: 'imported',
    description: clip.description,
    keyframes: clip.keys.map((key) => ({
      time: key.t,
      label: key.phase,
      jointValues: Object.fromEntries(
        joints
          .map((joint) => [joint.id, valueForKey(joint, key)] as const)
          .filter((entry): entry is readonly [string, number] => Number.isFinite(entry[1])),
      ),
    })),
  }));
};

const extractConveyorRig = (scene: THREE.Object3D): ProfessionalRigImport | undefined => {
  const rig = findConveyorRoot(scene);
  if (!rig) return undefined;
  const objects = objectMapByName(scene);
  const rootPartId = id('part', 'FRAME_fixed');
  const partSpecs = [
    { name: 'FRAME_fixed', object: objects.get('FRAME_fixed') ?? rig.root, static: true },
    { name: 'R1_drive_roller', object: objects.get('R1_drive_roller') },
    { name: 'R2_idler_roller', object: objects.get('R2_idler_roller') },
    { name: 'BELT_surface', object: objects.get('BELT_surface'), static: true },
    { name: 'S1_stopper', object: objects.get('S1_stopper') },
    { name: 'PARTS_optional', object: objects.get('PARTS_optional') },
  ];
  const partIdByName = new Map<string, string>([['FRAME_fixed', rootPartId]]);
  const parts = partSpecs.map((part) => {
    const partId = part.name === 'FRAME_fixed' ? rootPartId : id('part', part.name);
    partIdByName.set(part.name, partId);
    return makePart(partId, part.name, part.object, Boolean(part.static), 'conveyor-rig/1.0');
  });

  const conveyorJoints = (rig.metadata.joints as Array<Record<string, unknown>>).filter((joint) => joint.type !== 'texture_offset');
  const homeJointValues: Record<string, number> = {};
  const importedJoints: ImportedJointPose[] = [];
  const joints: KinematicJoint[] = [];

  conveyorJoints.forEach((metadata) => {
    const name = String(metadata.name ?? '');
    const object = objects.get(name);
    const childPartId = partIdByName.get(name);
    const rigAxis = String(metadata.axis ?? 'Z') as RigAxis;
    const axis = normalizeAxis(axisVector(rigAxis));
    if (!name || !object || !childPartId || !axis) return;
    const origin = jointWorldOrigin(object);
    const frame = createJointFrame(origin, axis, 'imported', {
      primitive: metadata.type === 'prismatic' ? 'plane' : 'cylinder',
      evidenceLevel: 'high',
      messages: ['Imported from conveyor rig metadata; belt geometry remains unchanged.'],
    }, 'accepted');
    if (!frame) return;

    const type = metadata.type === 'prismatic' ? 'prismatic' : metadata.type === 'continuous' ? 'continuous' : 'fixed';
    const localAxis = axisKey(rigAxis);
    const restValue = type === 'prismatic' ? object.position[localAxis] : object.rotation[localAxis];
    const absoluteLimits = Array.isArray(metadata.limitsMeters) ? (metadata.limitsMeters as [number, number]) : undefined;
    const jointId = id('joint', name);
    const limits = absoluteLimits
      ? {
          lower: Math.min(absoluteLimits[0] - restValue, absoluteLimits[1] - restValue),
          upper: Math.max(absoluteLimits[0] - restValue, absoluteLimits[1] - restValue),
          velocity: Number(rig.metadata.maxSpeedMetersPerSec) || undefined,
        }
      : undefined;
    homeJointValues[jointId] = 0;
    importedJoints.push({
      name,
      label: name.replace(/_/g, ' '),
      sourceType: 'object',
      motionKind: type === 'prismatic' ? 'translation' : 'rotation',
      axis: localAxis,
      cursorControl: type === 'prismatic' ? 'linear-axis' : 'dial-rotation',
      min: limits?.lower,
      max: limits?.upper,
      demoAmplitude: type === 'prismatic' ? 0.09 : Math.PI * 2,
      rotation: [0, 0, 0],
      translation: [0, 0, 0],
    });
    joints.push({
      id: jointId,
      name,
      parentPartId: rootPartId,
      childPartId,
      type,
      origin: { position: origin, rotation: frame.orientation },
      axis,
      jointFrame: frame,
      limits,
      source: 'imported',
      confidence: 0.98,
      evidence: [
        {
          type: 'imported-hierarchy',
          score: 0.98,
          message: `Conveyor rig joint ${name}: ${String(metadata.type)} ${String(metadata.axis)}.`,
          metadata: {
            sourceSchema: 'conveyor-rig/1.0',
            order: metadata.order,
            rigAxis,
            restValue,
            relation: metadata.relation,
            units: type === 'prismatic' ? 'meters' : 'radians',
          },
        },
      ],
      status: 'validated',
    });
  });

  const jointByOrder = new Map(joints.map((joint) => [joint.evidence[0]?.metadata?.order, joint]));
  const r1 = jointByOrder.get('R1');
  const r2 = jointByOrder.get('R2');
  const s1 = jointByOrder.get('S1');
  const cycleValues = (radians: number, stopper: number) =>
    Object.fromEntries(
      [
        r1 ? [r1.id, radians] : undefined,
        r2 ? [r2.id, radians] : undefined,
        s1 ? [s1.id, stopper] : undefined,
      ].filter((entry): entry is [string, number] => Boolean(entry)),
    );

  return {
    joints: importedJoints,
    kinematicGraph: {
      rootPartId,
      parts,
      joints,
      motionClips: [
        {
          id: 'clip_ciclo_transporte',
          name: 'Ciclo_Transporte',
          duration: 10,
          loop: true,
          source: 'imported',
          description: 'Cinta a 0.25 m/s con tope neumatico de estacion.',
          keyframes: [
            { time: 0, label: 'parada inicial', jointValues: cycleValues(0, 0) },
            { time: 1.2, label: 'banda en marcha', jointValues: cycleValues(-5.45, 0) },
            { time: 2.0, label: 'tope arriba', jointValues: cycleValues(-9.09, 0.09) },
            { time: 5.4, label: 'tope abajo', jointValues: cycleValues(-24.55, 0) },
            { time: 10, label: 'reinicio', jointValues: cycleValues(-45.45, 0) },
          ],
        },
      ],
      analysisVersion: 'conveyor-rig-1',
    },
    kinematicState: { homeJointValues, jointValues: { ...homeJointValues } },
    rigRootName: rig.root.name || 'ConveyorBelt2400',
    sourceSchema: 'conveyor-rig/1.0',
  };
};

const legacyRobotClips = (
  name: string,
  hasToolRoll: boolean,
  hasGrip: boolean,
): Array<{ name: string; durationSec: number; loop: boolean; description?: string; keys: GenericRigPoseKey[] }> => {
  const pose = (t: number, phase: string, J1: number, J2: number, J3: number, J4: number, J5: number, J6 = 0, grip = 1): GenericRigPoseKey => ({
    t,
    phase,
    J1,
    J2,
    J3,
    J4,
    J5,
    ...(hasToolRoll ? { J6 } : {}),
    ...(hasGrip ? { grip } : {}),
  });
  return [
    {
      name: 'Ciclo_Pick_And_Place',
      durationSec: 10,
      loop: true,
      description: `${name}: ciclo reconstruido desde la cadena mecanica detectada.`,
      keys: [
        pose(0, 'home', 0, -14, 42, 18, 0, 0, 1),
        pose(1.4, 'aproximacion', -34, 4, 58, 10, 0, 0, 1),
        pose(2.5, 'toma', -34, 20, 52, -6, 0, 0, 1),
        pose(3.2, 'cierre', -34, 20, 52, -6, 0, 0, 0),
        pose(4.2, 'elevacion', -34, 2, 58, 12, 0, 0, 0),
        pose(5.8, 'transferencia', 44, 2, 58, 12, 42, 60, 0),
        pose(7.4, 'deposito', 44, 18, 52, -8, 42, 60, 0),
        pose(8.1, 'apertura', 44, 18, 52, -8, 42, 60, 1),
        pose(9, 'retirada', 44, 0, 58, 12, 0, 0, 1),
        pose(10, 'home', 0, -14, 42, 18, 0, 0, 1),
      ],
    },
    {
      name: 'Ir_A_Home',
      durationSec: 2,
      loop: false,
      description: 'Retorno suave al estado inicial reconstruido.',
      keys: [pose(0, 'actual', 18, 16, 58, 8, 24, 24, hasGrip ? 0 : 1), pose(2, 'home', 0, -14, 42, 18, 0, 0, 1)],
    },
    {
      name: 'Demo_Ejes',
      durationSec: hasToolRoll ? 17.6 : 14.8,
      loop: true,
      description: 'Barrido eje por eje para verificar articulaciones reconstruidas.',
      keys: [
        pose(0, 'home', 0, -14, 42, 18, 0, 0, 1),
        pose(1.6, 'J1 izquierda', -90, -14, 42, 18, 0, 0, 1),
        pose(3.2, 'J1 derecha', 90, -14, 42, 18, 0, 0, 1),
        pose(4.6, 'J2 arriba', 0, 42, 42, 18, 0, 0, 1),
        pose(6.0, 'J2 abajo', 0, -42, 42, 18, 0, 0, 1),
        pose(7.4, 'J3 pliegue', 0, -14, 92, 18, 0, 0, 1),
        pose(8.8, 'J3 extension', 0, -14, 4, 18, 0, 0, 1),
        pose(10.2, 'J4 muneca', 0, -14, 42, 70, 0, 0, 1),
        pose(11.6, 'J4 retorno', 0, -14, 42, -44, 0, 0, 1),
        pose(13.0, 'J5 roll', 0, -14, 42, 18, 110, hasToolRoll ? 0 : 110, 1),
        pose(14.8, 'J5 retorno', 0, -14, 42, 18, 0, 0, hasGrip ? 0 : 1),
        ...(hasToolRoll ? [pose(16.2, 'J6 herramienta', 0, -14, 42, 18, 0, 180, hasGrip ? 0 : 1)] : []),
        pose(hasToolRoll ? 17.6 : 14.8, 'home', 0, -14, 42, 18, 0, 0, 1),
      ],
    },
  ];
};

const buildOldObjRobotRig = (scene: THREE.Object3D, objects: Map<string, THREE.Object3D>): ProfessionalRigImport | undefined => {
  const base = firstNameMatching(objects, [/^Robot$/]);
  const head = firstNameMatching(objects, [/Head__Axis_1_$/]);
  const arm1 = firstNameMatching(objects, [/Arm_1__Axis_2_$/]);
  const arm2 = firstNameMatching(objects, [/Arm_2__Axis_3_$/]);
  const arm3 = firstNameMatching(objects, [/Arm_3__Axis_4_$/]);
  const wrist = firstNameMatching(objects, [/Joint__Axis_5_$/]);
  const grasper = firstNameMatching(objects, [/Grasper_base$/]);
  const left = firstNameMatching(objects, [/grasper_L$/]);
  const right = firstNameMatching(objects, [/grasper_R$/]);
  if (!base || !head || !arm1 || !arm2 || !arm3 || !wrist || !grasper || !left || !right) return undefined;
  const j1Origin = jointOriginBetweenParts(objects, [base], [head], head);
  const j2Origin = jointOriginBetweenParts(objects, [head], [arm1], arm1);
  const j3Origin = jointOriginBetweenParts(objects, [arm1], [arm2], arm2);
  const j4Origin = jointOriginBetweenParts(objects, [arm2], [arm3], arm3);
  const j5Origin = jointOriginBetweenParts(objects, [arm3], [wrist, grasper], wrist);
  const j1Shape = roundedAxisFromObjects(objects, [base], 'Y') ?? radialBoundsAxisFromObjects(objects, [base], 'Y');
  const j5Shape = roundedAxisFromObjects(objects, [wrist], 'Y');

  return buildStaticRig(scene, {
    filePattern: /OBJ_Robot\.obj$/i,
    assetName: 'OBJ_Robot',
    rootName: 'LegacyAxisRobot',
    sourceSchema: 'legacy-robot-rig/1.0-axis-obj',
    analysisVersion: 'professional-rig-1.3-old-irobot-static-obj',
    rootPartName: 'BASE_fixed',
    parts: [
      { name: 'BASE_fixed', static: true, meshObjectIds: [base] },
      { name: 'J1_base_yaw', meshObjectIds: [head] },
      { name: 'J2_shoulder_pitch', meshObjectIds: [arm1] },
      { name: 'J3_elbow_pitch', meshObjectIds: [arm2] },
      { name: 'J4_wrist_pitch', meshObjectIds: [arm3] },
      { name: 'J5_tool_roll', meshObjectIds: [wrist, grasper] },
      { name: 'G1_finger_L', meshObjectIds: [left] },
      { name: 'G1_finger_R', meshObjectIds: [right] },
    ],
    joints: jointsWithOrigin(
      jointMetadata({ name: 'J1_base_yaw', order: 'J1', type: 'revolute', axis: 'Y', parent: 'BASE_fixed', pivotObjectName: head, shape: j1Shape, fallbackOrigin: j1Origin, limitsDeg: [-150, 150], homeDeg: 0, maxSpeedDegPerSec: 150 }),
      jointMetadata({ name: 'J2_shoulder_pitch', order: 'J2', type: 'revolute', axis: 'Z', parent: 'J1_base_yaw', pivotObjectName: arm1, fallbackOrigin: j2Origin, limitsDeg: [-65, 75], homeDeg: 0, maxSpeedDegPerSec: 120 }),
      jointMetadata({ name: 'J3_elbow_pitch', order: 'J3', type: 'revolute', axis: 'Z', parent: 'J2_shoulder_pitch', pivotObjectName: arm2, fallbackOrigin: j3Origin, limitsDeg: [-35, 105], homeDeg: 0, maxSpeedDegPerSec: 130 }),
      jointMetadata({ name: 'J4_wrist_pitch', order: 'J4', type: 'revolute', axis: 'Z', parent: 'J3_elbow_pitch', pivotObjectName: arm3, fallbackOrigin: j4Origin, limitsDeg: [-85, 85], homeDeg: 0, maxSpeedDegPerSec: 180 }),
      jointMetadata({ name: 'J5_tool_roll', order: 'J5', type: 'revolute', axis: 'Y', parent: 'J4_wrist_pitch', pivotObjectName: wrist, shape: j5Shape, fallbackOrigin: j5Origin, limitsDeg: [-135, 135], homeDeg: 0, maxSpeedDegPerSec: 220 }),
      { name: 'G1_finger_L', order: 'G1', type: 'prismatic', axis: 'X', parent: 'J5_tool_roll', pivotObjectName: left, originMeters: centerOfObject(objects, left), limitsMeters: [-0.032, 0.032], homeMeters: -0.032, maxSpeedMetersPerSec: 0.09 },
      { name: 'G1_finger_R', order: 'G1', type: 'prismatic', axis: 'X', parent: 'J5_tool_roll', pivotObjectName: right, originMeters: centerOfObject(objects, right), limitsMeters: [-0.032, 0.032], homeMeters: 0.032, maxSpeedMetersPerSec: 0.09 },
    ),
    gripper: { type: 'parallel_2_finger', axis: 'X', openMeters: 0.032, closedMeters: 0.01, strokeMeters: 0.044 },
    clips: legacyRobotClips('OBJ_Robot', false, true),
  });
};

const buildOldRmk3Rig = (scene: THREE.Object3D, objects: Map<string, THREE.Object3D>): ProfessionalRigImport | undefined => {
  const base = namesMatching(objects, [/BASE__not_moving_$/]);
  const baseRotating = namesMatching(objects, [/BASE__rotating_A-axis_|Silnik_/]);
  const armPrime = namesMatching(objects, [/ARM__prime_$/]);
  const armSecond = namesMatching(objects, [/ARM__second_|G1ring/]);
  const armRotating = namesMatching(objects, [/ARM__rotating_1|Rami__G2-1/]);
  const headPitch = namesMatching(objects, [/HEAD__pith_|G_owica_ruchoma|G2ring/]);
  const headRotating = namesMatching(objects, [/HEAD__rotating_.*Chwytak_[BS]-1/]);
  const leftGrip = namesMatching(objects, [/LEFT_GRIP/]);
  const rightGrip = namesMatching(objects, [/RIGHT_GRIP/]);
  const pivot = {
    J1: firstNameMatching(objects, [/BASE__rotating_A-axis_/]),
    J2: armPrime[0],
    J3: firstNameMatching(objects, [/ARM__second_$/]) ?? armSecond[0],
    J4: firstNameMatching(objects, [/ARM__rotating_1/]) ?? armRotating[0],
    J5: firstNameMatching(objects, [/G_owica_ruchoma|HEAD__pith_.*null3/]) ?? headPitch[0],
    J6: firstNameMatching(objects, [/Chwytak_B-1/]) ?? headRotating[0],
    L: firstNameMatching(objects, [/LEFT_GRIP.*Grip/]) ?? leftGrip[0],
    R: firstNameMatching(objects, [/RIGHT_GRIP.*Grip/]) ?? rightGrip[0],
  };
  if (!base.length || !baseRotating.length || !armPrime.length || !armSecond.length || !armRotating.length || !headPitch.length || !headRotating.length || !leftGrip.length || !rightGrip.length) return undefined;
  const j1Origin = jointOriginBetweenParts(objects, base, baseRotating, pivot.J1);
  const j2Origin = jointOriginBetweenParts(objects, baseRotating, armPrime, pivot.J2);
  const j3Origin = jointOriginBetweenParts(objects, armPrime, armSecond, pivot.J3);
  const j4Origin = jointOriginBetweenParts(objects, armSecond, armRotating, pivot.J4);
  const j5Origin = jointOriginBetweenParts(objects, armRotating, headPitch, pivot.J5);
  const j6Origin = jointOriginBetweenParts(objects, headPitch, headRotating, pivot.J6);
  const j1Shape = roundedAxisFromObjects(objects, baseRotating, 'Y') ?? radialBoundsAxisFromObjects(objects, baseRotating, 'Y');
  const j3Shape = roundedAxisFromObjects(objects, [pivot.J3], 'Z');
  const j4Shape = roundedAxisFromObjects(objects, [pivot.J4], 'Z');
  const j5Shape = roundedAxisFromObjects(objects, [pivot.J5], 'Y');
  const j6Shape = roundedAxisFromObjects(objects, [pivot.J6], 'Y');

  return buildStaticRig(scene, {
    filePattern: /Rmk3\.obj$/i,
    assetName: 'Rmk3',
    rootName: 'Rmk3LegacyRobot',
    sourceSchema: 'legacy-robot-rig/1.0-rmk3-obj',
    analysisVersion: 'professional-rig-1.3-old-rmk3-static-obj',
    rootPartName: 'BASE_fixed',
    parts: [
      { name: 'BASE_fixed', static: true, meshObjectIds: base },
      { name: 'J1_base_yaw', meshObjectIds: baseRotating },
      { name: 'J2_shoulder_pitch', meshObjectIds: armPrime },
      { name: 'J3_elbow_pitch', meshObjectIds: armSecond },
      { name: 'J4_wrist_pitch', meshObjectIds: armRotating },
      { name: 'J5_tool_roll', meshObjectIds: headPitch },
      { name: 'J6_tool_roll', meshObjectIds: headRotating },
      { name: 'G1_finger_L', meshObjectIds: leftGrip },
      { name: 'G1_finger_R', meshObjectIds: rightGrip },
    ],
    joints: jointsWithOrigin(
      jointMetadata({ name: 'J1_base_yaw', order: 'J1', type: 'revolute', axis: 'Y', parent: 'BASE_fixed', pivotObjectName: pivot.J1, shape: j1Shape, fallbackOrigin: j1Origin, limitsDeg: [-150, 150], homeDeg: 0, maxSpeedDegPerSec: 150 }),
      jointMetadata({ name: 'J2_shoulder_pitch', order: 'J2', type: 'revolute', axis: 'Z', parent: 'J1_base_yaw', pivotObjectName: pivot.J2, fallbackOrigin: j2Origin, limitsDeg: [-65, 75], homeDeg: 0, maxSpeedDegPerSec: 120 }),
      jointMetadata({ name: 'J3_elbow_pitch', order: 'J3', type: 'revolute', axis: 'Z', parent: 'J2_shoulder_pitch', pivotObjectName: pivot.J3, shape: j3Shape, fallbackOrigin: j3Origin, limitsDeg: [-40, 105], homeDeg: 0, maxSpeedDegPerSec: 130 }),
      jointMetadata({ name: 'J4_wrist_pitch', order: 'J4', type: 'revolute', axis: 'Z', parent: 'J3_elbow_pitch', pivotObjectName: pivot.J4, shape: j4Shape, fallbackOrigin: j4Origin, limitsDeg: [-85, 85], homeDeg: 0, maxSpeedDegPerSec: 180 }),
      jointMetadata({ name: 'J5_tool_roll', order: 'J5', type: 'revolute', axis: 'Y', parent: 'J4_wrist_pitch', pivotObjectName: pivot.J5, shape: j5Shape, fallbackOrigin: j5Origin, limitsDeg: [-135, 135], homeDeg: 0, maxSpeedDegPerSec: 220 }),
      jointMetadata({ name: 'J6_tool_roll', order: 'J6', type: 'revolute', axis: 'Y', parent: 'J5_tool_roll', pivotObjectName: pivot.J6, shape: j6Shape, fallbackOrigin: j6Origin, limitsDeg: [-220, 220], homeDeg: 0, maxSpeedDegPerSec: 260 }),
      { name: 'G1_finger_L', order: 'G1', type: 'prismatic', axis: 'X', parent: 'J6_tool_roll', pivotObjectName: pivot.L, originMeters: pivot.L ? centerOfObject(objects, pivot.L) : undefined, limitsMeters: [-0.045, 0.045], homeMeters: -0.045, maxSpeedMetersPerSec: 0.09 },
      { name: 'G1_finger_R', order: 'G1', type: 'prismatic', axis: 'X', parent: 'J6_tool_roll', pivotObjectName: pivot.R, originMeters: pivot.R ? centerOfObject(objects, pivot.R) : undefined, limitsMeters: [-0.045, 0.045], homeMeters: 0.045, maxSpeedMetersPerSec: 0.09 },
    ),
    gripper: { type: 'parallel_2_finger', axis: 'X', openMeters: 0.045, closedMeters: 0.014, strokeMeters: 0.062 },
    clips: legacyRobotClips('Rmk3', true, true),
  });
};

const buildOldIraMk4Rig = (scene: THREE.Object3D, objects: Map<string, THREE.Object3D>): ProfessionalRigImport | undefined => {
  if (!objects.has('__-_BASE_N') || !objects.has('Z_o_e37') || !objects.has('Z_o_e56')) return undefined;
  const base = namesMatching(objects, [/^__-_BASE_N$|^TooBig[0-6]$|^Z_o_e(?:90|94|95|98|99|69)$/]);
  const j1 = namesMatching(objects, [/^Z_o_e(?:15|16|17|18|19|20|21|22|23|24|25|26)$|^TooBig(?:8|9|10|11|12|13)$/]);
  const j2 = namesMatching(objects, [/^Z_o_e(?:37|38|39|40|41|42|43|44|45|46|47|48|49|50)$|^TooBig(?:14|15|16|17|18)$/]);
  const j3 = namesMatching(objects, [/^Z_o_e(?:53|54|55|56|57|58|59|60|61|62|63|64|65|66|67|68|enie1_)$|^TooBig(?:19|20|21)$/]);
  const j4 = namesMatching(objects, [/^Z_o_e(?:70|71|72|73|74|75|76|77|78|79|80|81|82|83|84|109|110)$|^TooBig(?:22|23|24|25|26|27|28|30|32)$/]);
  const j5 = namesMatching(objects, [/^Z_o_e(?:28|87|92|93|96|97)$/]);
  if (!base.length || !j1.length || !j2.length || !j3.length || !j4.length || !j5.length) return undefined;
  const grouping = [
    { names: base, center: centerOfObject(objects, '__-_BASE_N') },
    { names: j1, center: centerOfObject(objects, 'Z_o_e15') },
    { names: j2, center: centerOfObject(objects, 'Z_o_e37') },
    { names: j3, center: centerOfObject(objects, 'Z_o_e56') },
    { names: j4, center: centerOfObject(objects, 'Z_o_e109') },
    { names: j5, center: centerOfObject(objects, 'Z_o_e93') },
  ].filter((group): group is { names: string[]; center: Vector3Tuple } => Boolean(group.center));
  const assigned = new Set(grouping.flatMap((group) => group.names));
  objects.forEach((object, name) => {
    if (assigned.has(name)) return;
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const center = centerOfObject(objects, name);
    if (!center) return;
    const closest = grouping
      .map((group) => ({ group, distance: distanceBetween(center, group.center) }))
      .sort((a, b) => a.distance - b.distance)[0]?.group;
    if (!closest) return;
    closest.names.push(name);
    assigned.add(name);
  });
  const j1Origin = jointOriginBetweenParts(objects, base, j1, 'Z_o_e15');
  const j2Origin = jointOriginBetweenParts(objects, j1, j2, 'Z_o_e37');
  const j3Origin = jointOriginBetweenParts(objects, j2, j3, 'Z_o_e56');
  const j4Origin = jointOriginBetweenParts(objects, j3, j4, 'Z_o_e109');
  const j5Origin = jointOriginBetweenParts(objects, j4, j5, 'Z_o_e93');
  const j4Shape = roundedAxisFromObjects(objects, ['Z_o_e109'], 'Z');

  return buildStaticRig(scene, {
    filePattern: /IRAmk4\.3ds$/i,
    assetName: 'IRAmk4',
    rootName: 'IRAmk4LegacyRobot',
    sourceSchema: 'legacy-robot-rig/1.0-iramk4-3ds',
    analysisVersion: 'professional-rig-1.3-old-iramk4-static-obj',
    rootPartName: 'BASE_fixed',
    parts: [
      { name: 'BASE_fixed', static: true, meshObjectIds: base },
      { name: 'J1_base_yaw', meshObjectIds: j1 },
      { name: 'J2_shoulder_pitch', meshObjectIds: j2 },
      { name: 'J3_elbow_pitch', meshObjectIds: j3 },
      { name: 'J4_wrist_pitch', meshObjectIds: j4 },
      { name: 'J5_tool_roll', meshObjectIds: j5 },
    ],
    joints: jointsWithOrigin(
      jointMetadata({ name: 'J1_base_yaw', order: 'J1', type: 'revolute', axis: 'Y', parent: 'BASE_fixed', pivotObjectName: 'Z_o_e15', fallbackOrigin: j1Origin, limitsDeg: [-145, 145], homeDeg: 0, maxSpeedDegPerSec: 140 }),
      jointMetadata({ name: 'J2_shoulder_pitch', order: 'J2', type: 'revolute', axis: 'Z', parent: 'J1_base_yaw', pivotObjectName: 'Z_o_e37', fallbackOrigin: j2Origin, limitsDeg: [-60, 70], homeDeg: 0, maxSpeedDegPerSec: 115 }),
      jointMetadata({ name: 'J3_elbow_pitch', order: 'J3', type: 'revolute', axis: 'Z', parent: 'J2_shoulder_pitch', pivotObjectName: 'Z_o_e56', fallbackOrigin: j3Origin, limitsDeg: [-38, 100], homeDeg: 0, maxSpeedDegPerSec: 125 }),
      jointMetadata({ name: 'J4_wrist_pitch', order: 'J4', type: 'revolute', axis: 'Z', parent: 'J3_elbow_pitch', pivotObjectName: 'Z_o_e109', shape: j4Shape, fallbackOrigin: j4Origin, limitsDeg: [-80, 80], homeDeg: 0, maxSpeedDegPerSec: 175 }),
      jointMetadata({ name: 'J5_tool_roll', order: 'J5', type: 'revolute', axis: 'Y', parent: 'J4_wrist_pitch', pivotObjectName: 'Z_o_e93', fallbackOrigin: j5Origin, limitsDeg: [-130, 130], homeDeg: 0, maxSpeedDegPerSec: 220 }),
    ),
    clips: legacyRobotClips('IRAmk4', false, false),
  });
};

const buildOldRobotRig = (scene: THREE.Object3D, fileName: string): ProfessionalRigImport | undefined => {
  const objects = objectMapByName(scene);
  if (/OBJ_Robot\.obj$/i.test(fileName)) return buildOldObjRobotRig(scene, objects);
  if (/Rmk3\.obj$/i.test(fileName)) return buildOldRmk3Rig(scene, objects);
  if (/IRAmk4\.3ds$/i.test(fileName)) return buildOldIraMk4Rig(scene, objects);
  return undefined;
};

export const createProfessionalRobotRigFromStaticObj = (scene: THREE.Object3D, fileName: string): ProfessionalRigImport | undefined => {
  const oldRobot = buildOldRobotRig(scene, fileName);
  if (oldRobot) return oldRobot;

  const cellSpec = CELL_STATIC_RIG_SPECS.find((spec) => spec.filePattern.test(fileName));
  if (cellSpec) {
    applyCellStaticRigMaterials(scene, fileName);
    const recovered = buildStaticRig(scene, cellSpec);
    if (recovered) return recovered;
  }

  if (!/brazo-robot-industrial\.obj$/i.test(fileName)) return undefined;
  scene.updateMatrixWorld(true);
  const objects = objectMapByName(scene);
  const hasRequiredMeshes = ['base_plate', 'turret_body', 'upper_arm', 'forearm', 'wrist_link', 'gripper_finger_L', 'gripper_finger_R'].every((name) => objects.has(name));
  if (!hasRequiredMeshes) return undefined;

  applyStaticObjRobotMaterials(scene);

  const sourceSchema = 'robot-arm-rig/1.0';
  const recoveredFrame = inferStaticObjRigFrame(objects);
  const rootPartId = id('part', 'BASE_fixed');
  const partIdByName = new Map<string, string>([['BASE_fixed', rootPartId]]);
  const parts: MechanicalPart[] = [makeStaticObjPart(rootPartId, 'BASE_fixed', STATIC_OBJ_MESH_IDS.BASE_fixed, objects, true, sourceSchema)];
  STATIC_OBJ_JOINTS.forEach((metadata) => {
    const partId = id('part', metadata.name);
    partIdByName.set(metadata.name, partId);
    parts.push(makeStaticObjPart(partId, metadata.name, STATIC_OBJ_MESH_IDS[metadata.name] ?? [], objects, metadata.type === 'fixed', sourceSchema));
  });

  const homeJointValues: Record<string, number> = {};
  const restValueByJointId = new Map<string, number>();
  const importedJoints: ImportedJointPose[] = [];
  const joints: KinematicJoint[] = [];
  const gripper = { type: 'parallel_2_finger', axis: 'X' as RigAxis, openMeters: 0.085, closedMeters: 0.032, strokeMeters: 0.106 };

  STATIC_OBJ_JOINTS.forEach((metadata) => {
    const childPartId = partIdByName.get(metadata.name);
    const parentPartId = partIdByName.get(metadata.parent ?? 'BASE_fixed') ?? rootPartId;
    const axis = normalizeAxis(recoveredFrame.axes[metadata.name] ?? axisVector(metadata.axis));
    const origin = recoveredFrame.origins[metadata.name] ?? metadata.originMeters;
    if (!childPartId || !axis || !origin) return;
    const frame = createJointFrame(origin, axis, 'imported', {
      primitive: metadata.type === 'prismatic' ? 'plane' : 'cylinder',
      evidenceLevel: 'high',
      messages: ['Recovered from the robot OBJ companion rig. The OBJ geometry remains unchanged.'],
    }, 'accepted');
    if (!frame) return;

    const restValue = recoveredFrame.restValues[metadata.name] ?? 0;
    const limits = absoluteLimits(metadata);
    const isStaticGripper = metadata.type === 'prismatic' && /finger_[lr]$/i.test(metadata.name);
    const gripperTravel = (gripper.openMeters ?? 0.085) - (gripper.closedMeters ?? 0.032);
    const lower = isStaticGripper ? (/finger_l$/i.test(metadata.name) ? 0 : -gripperTravel) : limits ? Math.min(limits[0] - restValue, limits[1] - restValue) : undefined;
    const upper = isStaticGripper ? (/finger_l$/i.test(metadata.name) ? gripperTravel : 0) : limits ? Math.max(limits[0] - restValue, limits[1] - restValue) : undefined;
    const jointId = id('joint', metadata.name);
    homeJointValues[jointId] = 0;
    restValueByJointId.set(jointId, restValue);
    importedJoints.push({
      name: metadata.name,
      label: metadata.name.replace(/_/g, ' '),
      sourceType: 'object',
      motionKind: metadata.type === 'prismatic' ? 'translation' : 'rotation',
      axis: axisKey(metadata.axis),
      cursorControl: metadata.type === 'prismatic' ? 'linear-axis' : metadata.axis === 'Y' ? 'horizontal-rotation' : 'vertical-rotation',
      min: lower,
      max: upper,
      demoAmplitude: metadata.type === 'prismatic' ? Math.min(Math.abs(upper ?? 0), 0.06) : Math.min(Math.abs(upper ?? 0), 0.9),
      rotation: [0, 0, 0],
      translation: [0, 0, 0],
    });
    joints.push({
      id: jointId,
      name: metadata.name,
      parentPartId,
      childPartId,
      type: metadata.type === 'continuous' ? 'continuous' : metadata.type === 'prismatic' ? 'prismatic' : metadata.type === 'fixed' ? 'fixed' : 'revolute',
      origin: { position: origin, rotation: frame.orientation },
      axis,
      jointFrame: frame,
      limits:
        lower !== undefined || upper !== undefined
          ? {
              lower,
              upper,
              velocity: metadata.type === 'prismatic' ? metadata.maxSpeedMetersPerSec : metadata.maxSpeedDegPerSec ? metadata.maxSpeedDegPerSec * DEG_TO_RAD : undefined,
            }
          : undefined,
      source: 'imported',
      confidence: 0.96,
      evidence: [
        {
          type: 'imported-hierarchy',
          score: 0.96,
          message: `Recovered static OBJ robot joint ${metadata.name}: ${metadata.type} ${metadata.axis}.`,
          metadata: {
            sourceSchema,
            order: metadata.order,
            absoluteLimits: limits,
            absoluteHome: restValue,
            restValue,
            recoveredFromStaticObj: true,
            recoveredOrigin: origin,
            recoveredAxis: axis,
            units: metadata.type === 'prismatic' ? 'meters' : 'radians',
          },
        },
      ],
      status: 'validated',
    });
  });

  const left = joints.find((joint) => /finger_l$/i.test(joint.name));
  const right = joints.find((joint) => /finger_r$/i.test(joint.name));
  if (left && right) {
    right.coupling = { driverJointId: left.id, multiplier: -1, offset: 0 };
  }

  return {
    joints: importedJoints,
    kinematicGraph: {
      rootPartId,
      parts,
      joints,
      logicalControls:
        left && right
          ? [
              {
                id: 'control_gripper_opening',
                name: 'Parallel gripper opening',
                jointMappings: [
                  { jointId: left.id, multiplier: 1, offset: 0 },
                  { jointId: right.id, multiplier: -1, offset: 0 },
                ],
              },
            ]
          : undefined,
      motionClips: staticObjMotionClips(joints, restValueByJointId, gripper),
      analysisVersion: 'professional-rig-1-static-obj',
    },
    kinematicState: {
      homeJointValues,
      jointValues: { ...homeJointValues },
    },
    rigRootName: 'IndustrialRobotArm',
    sourceSchema,
  };
};

export const extractProfessionalRobotRig = (scene: THREE.Object3D, animations: THREE.AnimationClip[] = []): ProfessionalRigImport | undefined => {
  scene.updateMatrixWorld(true);
  const conveyorRig = extractConveyorRig(scene);
  if (conveyorRig) return conveyorRig;

  const rig = findRigRoot(scene);
  if (!rig || !rig.metadata.joints?.length) return undefined;

  const objects = objectMapByName(scene);
  const rigJointNames = new Set(rig.metadata.joints.map((joint) => joint.name));
  const sourceSchema = rig.metadata.schema;
  const rootPartId = id('part', rig.root.name || 'professional_robot_root');
  const baseObject = objects.get('BASE_fixed') ?? rig.root;
  const parts: MechanicalPart[] = [makePart(rootPartId, baseObject.name || 'BASE fixed', baseObject, true, sourceSchema)];
  const partIdByJointName = new Map<string, string>();
  const homeJointValues: Record<string, number> = {};
  const restValueByJointId = new Map<string, number>();
  const importedJoints: ImportedJointPose[] = [];

  rig.metadata.joints.forEach((metadata) => {
    const object = objects.get(metadata.name);
    if (!object) return;
    const partId = id('part', metadata.name);
    partIdByJointName.set(metadata.name, partId);
    parts.push(makePart(partId, metadata.name, object, metadata.type === 'fixed', sourceSchema));
  });

  const joints: KinematicJoint[] = [];
  rig.metadata.joints.forEach((metadata) => {
    const object = objects.get(metadata.name);
    const childPartId = partIdByJointName.get(metadata.name);
    if (!object || !childPartId) return;

    const axis = normalizeAxis(parentAxisWorld(object, metadata.axis));
    if (!axis) return;
    const origin = jointWorldOrigin(object);
    const frame = createJointFrame(origin, axis, 'imported', {
      primitive: metadata.type === 'prismatic' ? 'plane' : 'cylinder',
      evidenceLevel: 'high',
      messages: ['Imported from professional robot rig metadata; click points are not used as pivots.'],
    }, 'accepted');
    if (!frame) return;

    const parentRigName = nearestRigAncestor(object, rigJointNames, rig.root);
    const parentPartId = parentRigName ? partIdByJointName.get(parentRigName) ?? rootPartId : rootPartId;
    const restValue = localJointValue(object, metadata);
    const limits = absoluteLimits(metadata);
    const homeValue = absoluteHome(metadata, rig.metadata, restValue);
    const lower = limits ? Math.min(limits[0] - restValue, limits[1] - restValue) : undefined;
    const upper = limits ? Math.max(limits[0] - restValue, limits[1] - restValue) : undefined;
    const jointId = id('joint', metadata.name);

    homeJointValues[jointId] = homeValue - restValue;
    restValueByJointId.set(jointId, restValue);
    importedJoints.push({
      name: metadata.name,
      label: metadata.name.replace(/_/g, ' '),
      sourceType: 'object',
      motionKind: metadata.type === 'prismatic' ? 'translation' : 'rotation',
      axis: axisKey(metadata.axis),
      cursorControl: metadata.type === 'prismatic' ? 'linear-axis' : metadata.axis === 'Y' ? 'horizontal-rotation' : 'vertical-rotation',
      min: lower,
      max: upper,
      demoAmplitude: metadata.type === 'prismatic' ? Math.min(Math.abs(upper ?? 0), 0.06) : Math.min(Math.abs(upper ?? 0), 0.9),
      rotation: [0, 0, 0],
      translation: [0, 0, 0],
    });

    joints.push({
      id: jointId,
      name: metadata.name,
      parentPartId,
      childPartId,
      type: metadata.type === 'continuous' ? 'continuous' : metadata.type === 'prismatic' ? 'prismatic' : metadata.type === 'fixed' ? 'fixed' : 'revolute',
      origin: { position: origin, rotation: frame.orientation },
      axis,
      jointFrame: frame,
      limits:
        lower !== undefined || upper !== undefined
          ? {
              lower,
              upper,
              velocity: metadata.maxSpeedDegPerSec ? metadata.maxSpeedDegPerSec * DEG_TO_RAD : undefined,
            }
          : undefined,
      source: 'imported',
      confidence: 0.98,
      evidence: [
        {
          type: 'imported-hierarchy',
          score: 0.98,
          message: `Professional rig joint ${metadata.name}: ${metadata.type} ${metadata.axis}.`,
          metadata: {
            sourceSchema,
            order: metadata.order,
            rigAxis: metadata.axis,
            absoluteLimits: limits,
            absoluteHome: homeValue,
            restValue,
            units: metadata.type === 'prismatic' ? 'meters' : 'radians',
          },
        },
      ],
      status: 'validated',
    });
  });

  const left = joints.find((joint) => /finger_l$/i.test(joint.name));
  const right = joints.find((joint) => /finger_r$/i.test(joint.name));
  if (left && right) {
    right.coupling = { driverJointId: left.id, multiplier: -1, offset: 0 };
  }

  const valueForKey = (joint: KinematicJoint, key: RobotArmPoseKey) => {
    const order = joint.evidence[0]?.metadata?.order;
    const restValue = restValueByJointId.get(joint.id) ?? 0;
    if (typeof order === 'string' && order !== 'J6') {
      const value = key[order as keyof RobotArmPoseKey];
      return Number.isFinite(value) ? (value as number) * DEG_TO_RAD - restValue : undefined;
    }
    if (order === 'J6' && Number.isFinite(key.grip)) {
      const open = rig.metadata.gripper?.openMeters ?? 0.085;
      const closed = rig.metadata.gripper?.closedMeters ?? 0.032;
      const x = closed + (open - closed) * (key.grip as number);
      const absolute = /finger_l$/i.test(joint.name) ? -x : x;
      return absolute - restValue;
    }
    return undefined;
  };

  const importedAnimationClips = motionClipsFromThreeAnimations(animations, joints, restValueByJointId, rig.metadata.clips);
  const motionClips: KinematicMotionClip[] =
    importedAnimationClips?.length && /^robot-arm-rig\/1\.1/i.test(sourceSchema)
      ? importedAnimationClips
      : ROBOT_ARM_RIG_CLIPS.map((clip) => ({
          id: id('clip', clip.name),
          name: clip.name,
          duration: clip.durationSec,
          loop: clip.loop,
          source: 'imported' as const,
          description: clip.description,
          keyframes: clip.keys.map((key) => ({
            time: key.t,
            label: key.phase,
            jointValues: Object.fromEntries(
              joints
                .map((joint) => [joint.id, valueForKey(joint, key)] as const)
                .filter((entry): entry is readonly [string, number] => Number.isFinite(entry[1])),
            ),
          })),
        }));

  return {
    joints: importedJoints,
    kinematicGraph: {
      rootPartId,
      parts,
      joints,
      logicalControls:
        left && right
          ? [
              {
                id: 'control_gripper_opening',
                name: 'Parallel gripper opening',
                jointMappings: [
                  { jointId: left.id, multiplier: 1, offset: 0 },
                  { jointId: right.id, multiplier: -1, offset: 0 },
                ],
              },
            ]
          : undefined,
      motionClips,
      analysisVersion: /^robot-arm-rig\/1\.1/i.test(sourceSchema) ? 'professional-rig-1.1' : 'professional-rig-1',
    },
    kinematicState: {
      homeJointValues,
      jointValues: { ...homeJointValues },
    },
    rigRootName: rig.root.name || 'ProfessionalRobotRig',
    sourceSchema,
  };
};
