import gantryRobotUrl from '../../../3d imported models/scenario_1/gantry-robot.glb?url';
import conveyorSegmentUrl from '../../../3d imported models/scenario_1/conveyor-segment.glb?url';
import inspectionMachineUrl from '../../../3d imported models/scenario_1/inspection-machine.glb?url';
import operatorUrl from '../../../3d imported models/scenario_1/operator.glb?url';
import cargoBoxUrl from '../../../3d imported models/scenario_1/cargo-box.glb?url';
import type { ImportedJointPose, ImportedModelGeometry, SceneNode, Vector3Tuple } from '../../domain/model';
import type { KinematicGraph, KinematicJoint } from '../../domain/kinematics';
import { createIndustrialScenePackNodes } from './industrialScenePack';

const cloneData = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const importedMaterial = () => ({
  name: 'Imported GLB',
  color: '#8b949e',
  roughness: 0.52,
  metalness: 0.08,
});

const dominantMotionAxis = (joint: KinematicJoint): 'x' | 'y' | 'z' => {
  const absolute = joint.axis.map((value) => Math.abs(value));
  const max = Math.max(...absolute);
  const index = absolute.indexOf(max);
  return index === 1 ? 'y' : index === 2 ? 'z' : 'x';
};

const importedJointPose = (joint: KinematicJoint): ImportedJointPose => ({
  name: joint.name,
  label: joint.name.replace(/_/g, ' '),
  sourceType: 'object',
  motionKind: joint.type === 'prismatic' ? 'translation' : 'rotation',
  axis: dominantMotionAxis(joint),
  min: joint.limits?.lower,
  max: joint.limits?.upper,
  demoAmplitude: joint.type === 'prismatic' ? 0.16 : 0.65,
  rotation: [0, 0, 0],
  translation: [0, 0, 0],
});

const assetForNode = (node: SceneNode) => {
  if (!('generatorId' in node.geometry)) return undefined;
  if (node.geometry.generatorId === 'industrial-gantry-5axis') return { url: gantryRobotUrl, assetName: 'scenario_1/gantry-robot.glb' };
  if (node.geometry.generatorId === 'industrial-conveyor-segment') return { url: conveyorSegmentUrl, assetName: 'scenario_1/conveyor-segment.glb' };
  if (node.geometry.generatorId === 'industrial-inspection-machine') return { url: inspectionMachineUrl, assetName: 'scenario_1/inspection-machine.glb' };
  if (node.geometry.generatorId === 'industrial-operator') return { url: operatorUrl, assetName: 'scenario_1/operator.glb' };
  if (node.geometry.generatorId === 'industrial-cargo-box') return { url: cargoBoxUrl, assetName: 'scenario_1/cargo-box.glb' };
  return undefined;
};

const importedGeometryFromNode = (node: SceneNode, assetUrl: string, assetName: string): ImportedModelGeometry => {
  if (!('kinematicGraph' in node.geometry) || !node.geometry.kinematicGraph || !node.geometry.kinematicState) {
    throw new Error(`${node.name} has no industrial kinematic contract`);
  }
  const graph = cloneData(node.geometry.kinematicGraph) as KinematicGraph;
  return {
    kind: 'imported-model',
    assetName,
    assetDataUrl: assetUrl,
    sourceFormat: 'glb',
    importScale: 1,
    importOffset: [0, 0, 0],
    originalBounds: cloneData(node.geometry.originalBounds ?? [1, 1, 1]) as Vector3Tuple,
    normalizedBounds: cloneData(node.geometry.normalizedBounds ?? node.geometry.originalBounds ?? [1, 1, 1]) as Vector3Tuple,
    bones: [],
    animations: graph.motionClips?.map((clip) => clip.name) ?? [],
    joints: graph.joints.map(importedJointPose),
    kinematicGraph: graph,
    kinematicState: cloneData(node.geometry.kinematicState),
  };
};

export const createScenarioOneRealCellNodes = (): SceneNode[] =>
  createIndustrialScenePackNodes()
    .filter((node) => !('generatorId' in node.geometry && node.geometry.generatorId === 'industrial-cargo-stack'))
    .map((node) => {
      const asset = assetForNode(node);
      if (!asset) return node;
      return {
        ...node,
        geometry: importedGeometryFromNode(node, asset.url, asset.assetName),
        material: importedMaterial(),
      };
    });
