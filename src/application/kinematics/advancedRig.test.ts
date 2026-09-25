import type { KinematicGraph, KinematicState } from '../../domain/kinematics';
import {
  activeMotionClip,
  buildRigHierarchy,
  createMotionClip,
  deleteMotionKeyframe,
  diagnoseAdvancedRig,
  ensureRigControls,
  frameToSeconds,
  moveMotionKeyframe,
  normalizeAnimationSettings,
  secondsToFrame,
  upsertPoseKeyframe,
} from './advancedRig';

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const frame = (position: [number, number, number] = [0, 0, 0]) => ({ position, rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] });
const bounds = { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number], size: [2, 2, 2] as [number, number, number], center: [0, 0, 0] as [number, number, number] };

const graph: KinematicGraph = {
  rootPartId: 'base',
  parts: [
    { id: 'base', name: 'Base', meshObjectIds: ['Base'], localFrame: frame(), bounds, static: true, visible: true, source: 'imported', metadata: {} },
    { id: 'arm', name: 'Arm', meshObjectIds: ['Arm'], localFrame: frame(), bounds, static: false, visible: true, source: 'imported', metadata: {} },
    { id: 'tool', name: 'Tool', meshObjectIds: ['Tool'], localFrame: frame(), bounds, static: false, visible: true, source: 'imported', metadata: {} },
  ],
  joints: [
    { id: 'j1', name: 'Base yaw', parentPartId: 'base', childPartId: 'arm', type: 'revolute', origin: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, axis: [0, 1, 0], limits: { lower: -1, upper: 1 }, source: 'manual', evidence: [], status: 'validated' },
    { id: 'j2', name: 'Tool slide', parentPartId: 'arm', childPartId: 'tool', type: 'prismatic', origin: { position: [0, 1, 0], rotation: [0, 0, 0, 1] }, axis: [1, 0, 0], limits: { lower: 0, upper: 0.2 }, source: 'manual', evidence: [], status: 'validated' },
  ],
};

const hierarchy = buildRigHierarchy(graph);
assert(hierarchy.length === 1, 'Expected one rig root.');
assert(hierarchy[0].children[0].children[0].part.id === 'tool', 'Hierarchy order is incorrect.');

const controlled = ensureRigControls(graph);
assert(controlled.rigControls?.length === 2, 'Default rig controls were not generated.');
assert(controlled.rigControls?.find((control) => control.jointId === 'j1')?.shape === 'ring', 'Revolute joint needs a ring control.');
assert(controlled.rigControls?.find((control) => control.jointId === 'j2')?.shape === 'slider', 'Prismatic joint needs a slider control.');

const created = createMotionClip(controlled, 'Assembly cycle', 4);
const state: KinematicState = { homeJointValues: { j1: 0, j2: 0 }, jointValues: { j1: 0.5, j2: 0.1 } };
let animated = upsertPoseKeyframe(created.graph, created.clip.id, 0, state, { label: 'Start' });
animated = upsertPoseKeyframe(animated, created.clip.id, 2, { ...state, jointValues: { j1: -0.4, j2: 0.2 } }, { label: 'Pick' });
animated = upsertPoseKeyframe(animated, created.clip.id, 2, { ...state, jointValues: { j1: -0.2, j2: 0.15 } }, { selectedJointId: 'j1' });
assert(activeMotionClip(animated)?.keyframes.length === 2, 'Keyframes were not inserted or merged correctly.');
assert(activeMotionClip(animated)?.keyframes[1].jointValues.j1 === -0.2, 'Selected joint key did not replace its channel.');
assert(activeMotionClip(animated)?.keyframes[1].jointValues.j2 === 0.2, 'Unselected channel was unexpectedly removed.');

animated = moveMotionKeyframe(animated, created.clip.id, 1, 3);
assert(activeMotionClip(animated)?.keyframes[1].time === 3, 'Keyframe move failed.');
animated = deleteMotionKeyframe(animated, created.clip.id, 0);
assert(activeMotionClip(animated)?.keyframes.length === 1, 'Keyframe delete failed.');

assert(secondsToFrame(2, 24) === 48, 'Seconds to frame conversion failed.');
assert(frameToSeconds(48, 24) === 2, 'Frame to seconds conversion failed.');
assert(normalizeAnimationSettings({ fps: 1000 }).fps === 240, 'FPS upper bound failed.');
assert(diagnoseAdvancedRig(graph).every((item) => item.severity !== 'error'), 'Valid rig produced an error diagnosis.');

const invalid: KinematicGraph = { ...graph, joints: [{ ...graph.joints[0], limits: { lower: 2, upper: -2 } }] };
assert(diagnoseAdvancedRig(invalid).some((item) => item.code === 'INVERTED_LIMITS'), 'Invalid limits were not diagnosed.');

console.log('Advanced rig domain tests passed.');

