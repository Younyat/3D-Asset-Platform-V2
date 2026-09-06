import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import {
  AssetDocument,
  CursorMotionControl,
  EditorTool,
  ImportedJointPose,
  JointMotionKind,
  MotionAxis,
  PartEditMode,
  SceneNode,
  Transform,
  ValidatedJointMotion,
} from '../../domain/model';
import { evaluateForwardKinematics } from '../../application/kinematics/kinematicAuthoring';
import { sampleKinematicMotionClip } from '../../application/kinematics/robotMotionController';
import { estimatePieceReferenceCenter, type ReferenceTriangle } from '../../application/kinematics/referenceCenter';
import { analyzeGeometryCached, inferJointFrameFromSeed } from '../../application/kinematics/geometryAnalysis';
import type { GeometricProperties, JointFrameCandidate, KinematicJoint, MassProperties } from '../../domain/kinematics';
import { createRenderableSceneAsync } from '../../infrastructure/threeSceneFactory';

export type ViewportStats = {
  fps: number;
  objects: number;
  triangles: number;
  cpuPercent: number;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  memoryPercent?: number;
};

type ThreeViewportProps = {
  document: AssetDocument;
  tool: EditorTool;
  partEditMode: PartEditMode;
  snapEnabled: boolean;
  viewportNotice?: string;
  kinematicEditTarget?: KinematicEditTarget;
  motionDemoNodeId?: string;
  industrialCellDemoActive?: boolean;
  robotCursorGuideNodeId?: string;
  motionTrainingPreview?: MotionTrainingPreview;
  onSelect: (nodeId?: string) => void;
  onTransformCommit: (nodeId: string, transform: Transform) => void;
  onImportedPartTransformsCommit: (updates: Array<{ nodeId: string; objectName: string; transform: Transform }>) => void;
  onJointPoseChange: (nodeId: string, jointName: string, value: number) => void;
  onKinematicPointPick: (event: KinematicPointPickEvent) => void;
  onKinematicAxisChange: (event: KinematicAxisChangeEvent) => void;
  onRobotCursorGuide: (event: RobotCursorGuideEvent) => void;
  onPieceReferenceCenterEstimate: (event: PieceReferenceCenterEstimateEvent) => void;
  onPartSelectionChange: (selection: ImportedPartSelection[]) => void;
  onNodeContextMenu?: (event: ViewportContextMenuEvent) => void;
  onNodeDoubleClick?: (event: ViewportContextMenuEvent) => void;
  onStatsChange: (stats: ViewportStats) => void;
};

export type ViewportContextMenuEvent = {
  nodeId: string;
  x: number;
  y: number;
  objectName?: string;
  jointId?: string;
  jointIds?: string[];
  point?: [number, number, number];
  objectCenter?: [number, number, number];
};

export type ImportedPartSelection = {
  nodeId: string;
  objectName: string;
};

export type RobotCursorGuideEvent = {
  nodeId: string;
  point: [number, number, number];
  dragging: boolean;
};

export type MotionTrainingPreview = {
  nodeId: string;
  jointName: string;
  motionKind: JointMotionKind;
  axis: MotionAxis;
  min: number;
  max: number;
  amplitude: number;
};

export type KinematicEditMode = 'show-joint' | 'pick-origin' | 'pick-driven-point' | 'pick-axis-a' | 'pick-axis-b' | 'axis-gizmo';

export type KinematicEditTarget = {
  nodeId: string;
  jointId: string;
  mode: KinematicEditMode;
  origin: [number, number, number];
  axis: [number, number, number];
  axisPointA?: [number, number, number];
  drivenPoint?: [number, number, number];
  parentObjectNames?: string[];
  childObjectNames?: string[];
  affectedObjectNames?: string[];
  focusKey?: string;
};

export type KinematicPointPickEvent = {
  nodeId: string;
  jointId: string;
  mode: Extract<KinematicEditMode, 'pick-origin' | 'pick-driven-point' | 'pick-axis-a' | 'pick-axis-b'>;
  point: [number, number, number];
  objectName?: string;
  candidate?: JointFrameCandidate;
};

export type KinematicAxisChangeEvent = {
  nodeId: string;
  jointId: string;
  axis: [number, number, number];
};

export type PieceReferenceCenterEstimateEvent = {
  nodeId: string;
  position: [number, number, number];
  method: 'volume-centroid' | 'surface-centroid' | 'bounds-center' | 'manual';
  confidence: number;
  triangleCount: number;
  geometricProperties?: GeometricProperties;
  massProperties?: MassProperties;
};

const toTransform = (object: THREE.Object3D): Transform => ({
  position: object.position.toArray() as [number, number, number],
  rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
  scale: object.scale.toArray() as [number, number, number],
});

const countTriangles = (object: THREE.Object3D) => {
  let triangles = 0;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const geometry = mesh.geometry;
    if (!geometry) return;

    if (geometry.index) {
      triangles += geometry.index.count / 3;
    } else if (geometry.attributes.position) {
      triangles += geometry.attributes.position.count / 3;
    }
  });
  return Math.round(triangles);
};

const disposeHelperMaterial = (material: THREE.Material | THREE.Material[]) => {
  if (Array.isArray(material)) material.forEach((item) => item.dispose());
  else material.dispose();
};

const clearBoxHelpers = (scene: THREE.Scene, boxes: THREE.BoxHelper[]) => {
  boxes.splice(0).forEach((box) => {
    scene.remove(box);
    box.geometry.dispose();
    disposeHelperMaterial(box.material);
  });
};

const axisIndexOf = (axis?: 'x' | 'y' | 'z') => (axis === 'y' ? 1 : axis === 'z' ? 2 : 0);

const activeJointValue = (joint: ImportedJointPose) => {
  const axisIndex = axisIndexOf(joint.axis);
  return joint.motionKind === 'translation' ? joint.translation?.[axisIndex] ?? 0 : joint.rotation[axisIndex] ?? 0;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizeTuple = (value: [number, number, number]): [number, number, number] => {
  const length = Math.hypot(value[0], value[1], value[2]);
  return length > 0.000001 ? [value[0] / length, value[1] / length, value[2] / length] : [1, 0, 0];
};

const vectorTuple = (vector: THREE.Vector3): [number, number, number] => [vector.x, vector.y, vector.z];

const referenceTrianglesForObject = (nodeObject: THREE.Object3D, sourceObject: THREE.Object3D) => {
  const triangles: ReferenceTriangle[] = [];
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const sourcePoint = (mesh: THREE.Object3D, index: number) => {
    const position = (mesh as THREE.Mesh).geometry.attributes.position;
    const point = new THREE.Vector3().fromBufferAttribute(position, index);
    mesh.localToWorld(point);
    sourceObject.worldToLocal(point);
    min.min(point);
    max.max(point);
    return vectorTuple(point);
  };

  nodeObject.traverse((candidate) => {
    const mesh = candidate as THREE.Mesh;
    const position = mesh.geometry?.attributes.position;
    if (!mesh.isMesh || !position?.count) return;
    const index = mesh.geometry.index;
    const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const offset = triangle * 3;
      const a = sourcePoint(mesh, index ? index.getX(offset) : offset);
      const b = sourcePoint(mesh, index ? index.getX(offset + 1) : offset + 1);
      const c = sourcePoint(mesh, index ? index.getX(offset + 2) : offset + 2);
      triangles.push([a, b, c]);
    }
  });

  const boundsCenter: [number, number, number] = Number.isFinite(min.x)
    ? [(min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2]
    : [0, 0, 0];
  return { triangles, boundsCenter };
};

const logicalMotionValue = (joint: ImportedJointPose, index: number, elapsed: number) => {
  const name = joint.name.toLowerCase();
  const amplitude = joint.demoAmplitude ?? 0.45;
  const min = joint.min ?? -1.2;
  const max = joint.max ?? 1.2;
  let value = Math.sin(elapsed * (0.8 + index * 0.035)) * amplitude;

  if (/wheel|tire|tyre/.test(name)) value = elapsed * 3.2;
  else if (/grip|grasper|claw|finger/.test(name)) value = Math.sin(elapsed * 1.7) * amplitude;
  else if (/base|rotating|yaw/.test(name)) value = Math.sin(elapsed * 0.45) * amplitude;
  else if (/head|wrist/.test(name)) value = Math.sin(elapsed * 1.05 + index * 0.2) * amplitude;
  else if (/arm|joint|axis|elbow|shoulder/.test(name)) value = Math.sin(elapsed * 0.7 + index * 0.33) * amplitude;

  return Math.min(max, Math.max(min, value));
};

const previewMotionValue = (min: number, max: number, amplitude: number, elapsed: number) => {
  const boundedAmplitude = Math.min(Math.abs(amplitude), Math.abs(min), Math.abs(max));
  return Math.min(max, Math.max(min, Math.sin(elapsed * 1.3) * boundedAmplitude));
};

const orderedValidatedMotions = (motions: ValidatedJointMotion[] | undefined) => [...(motions ?? [])].sort((a, b) => a.order - b.order);

type BrowserMemoryInfo = {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
  jsHeapSizeLimit?: number;
};

const readBrowserMemory = () => {
  const memory = (performance as Performance & { memory?: BrowserMemoryInfo }).memory;
  if (!memory?.usedJSHeapSize) return {};
  const usedMb = memory.usedJSHeapSize / 1024 / 1024;
  const totalMb = (memory.jsHeapSizeLimit ?? memory.totalJSHeapSize ?? 0) / 1024 / 1024;
  return {
    memoryUsedMb: Math.round(usedMb),
    memoryTotalMb: totalMb ? Math.round(totalMb) : undefined,
    memoryPercent: totalMb ? Math.min(100, Math.round((usedMb / totalMb) * 100)) : undefined,
  };
};

const applyLogicalJointPose = (child: THREE.Object3D, joint: ImportedJointPose, valueOverride?: number) => {
  const axisIndex = axisIndexOf(joint.axis);
  const restRotation = (child.userData.restRotation as THREE.Euler | undefined) ?? child.rotation.clone();
  const restPosition = (child.userData.restPosition as THREE.Vector3 | undefined) ?? child.position.clone();
  child.userData.restRotation = restRotation;
  child.userData.restPosition = restPosition;
  child.rotation.set(restRotation.x, restRotation.y, restRotation.z);
  child.position.copy(restPosition);

  const value = valueOverride ?? activeJointValue(joint);

  if (joint.motionKind === 'translation') {
    if (axisIndex === 0) child.position.x = restPosition.x + value;
    if (axisIndex === 1) child.position.y = restPosition.y + value;
    if (axisIndex === 2) child.position.z = restPosition.z + value;
  } else {
    if (axisIndex === 0) child.rotation.x = restRotation.x + value;
    if (axisIndex === 1) child.rotation.y = restRotation.y + value;
    if (axisIndex === 2) child.rotation.z = restRotation.z + value;
  }

  child.updateMatrixWorld(true);
};

const applyDocumentJointPoses = (assetRoot: THREE.Group, document: AssetDocument) => {
  document.nodes.forEach((node) => {
    if (node.geometry.kind !== 'imported-model') return;
    if (node.geometry.kinematicState && node.geometry.kinematicGraph) return;
    const poseByName = new Map(node.geometry.joints.map((joint) => [joint.name, joint]));
    const freePartNames = new Set((node.geometry.freePartTransforms ?? []).map((partTransform) => partTransform.objectName));
    assetRoot.traverse((child) => {
      if (child.userData.nodeId !== node.id) return;
      if (child.userData.freeDragging || freePartNames.has(child.name)) return;
      const joint = poseByName.get(child.name);
      if (joint) applyLogicalJointPose(child, joint);
    });
  });
};

const matrixFromEvaluatedPose = (values: number[]) => {
  const matrix = new THREE.Matrix4();
  matrix.set(
    values[0],
    values[1],
    values[2],
    values[3],
    values[4],
    values[5],
    values[6],
    values[7],
    values[8],
    values[9],
    values[10],
    values[11],
    values[12],
    values[13],
    values[14],
    values[15],
  );
  return matrix;
};

const usesImportedHierarchyKinematics = (node: SceneNode) => {
  if (!('kinematicGraph' in node.geometry) || !node.geometry.kinematicGraph) return false;
  const version = node.geometry.kinematicGraph.analysisVersion ?? '';
  return (version === 'professional-rig-1.1' || version === 'conveyor-rig-1') && !version.includes('static-obj');
};

const usesStaticRigHierarchyKinematics = (node: SceneNode) => {
  if (!('kinematicGraph' in node.geometry) || !node.geometry.kinematicGraph) return false;
  const version = node.geometry.kinematicGraph.analysisVersion ?? '';
  return /^professional-rig-1\./.test(version) && version.includes('static-obj');
};

const usesIndustrialContractKinematics = (node: SceneNode) => {
  if (!('kinematicGraph' in node.geometry) || !node.geometry.kinematicGraph) return false;
  const version = node.geometry.kinematicGraph.analysisVersion ?? '';
  return version === 'industrial-scene-rig-1' || version === 'conveyor-rig-industrial-scene-1';
};

const industrialCellGeneratorId = (node: SceneNode) => {
  if ('generatorId' in node.geometry && node.geometry.generatorId.startsWith('industrial-')) return node.geometry.generatorId;
  if (node.geometry.kind !== 'imported-model') return '';
  if (!node.geometry.kinematicGraph?.analysisVersion?.includes('industrial-scene')) return '';
  if (/gantry-robot\.glb$/i.test(node.geometry.assetName)) return 'industrial-gantry-5axis';
  if (/conveyor-segment\.glb$/i.test(node.geometry.assetName)) return 'industrial-conveyor-segment';
  if (/inspection-machine\.glb$/i.test(node.geometry.assetName)) return 'industrial-inspection-machine';
  if (/operator\.glb$/i.test(node.geometry.assetName)) return 'industrial-operator';
  if (/cargo-box\.glb$/i.test(node.geometry.assetName)) return 'industrial-cargo-box';
  return '';
};

const isIndustrialGeneratedNode = (node: SceneNode) => Boolean(industrialCellGeneratorId(node));

const localAxisKeyFromJoint = (joint: { evidence: Array<{ metadata?: Record<string, unknown> }>; axis: [number, number, number] }) => {
  const rigAxis = joint.evidence[0]?.metadata?.rigAxis;
  if (rigAxis === 'Y') return 'y';
  if (rigAxis === 'Z') return 'z';
  if (rigAxis === 'X') return 'x';
  const absolute = joint.axis.map((value) => Math.abs(value));
  const index = absolute.indexOf(Math.max(...absolute));
  return index === 1 ? 'y' : index === 2 ? 'z' : 'x';
};

const clampJointValue = (joint: { type: string; limits?: { lower?: number; upper?: number } }, value: number) => {
  if (joint.type === 'continuous') return value;
  return Math.max(joint.limits?.lower ?? -Infinity, Math.min(joint.limits?.upper ?? Infinity, value));
};

const findDescendantByName = (root: THREE.Object3D, name: string) => {
  let result: THREE.Object3D | undefined;
  root.traverse((child) => {
    if (!result && child.name === name) result = child;
  });
  return result;
};

const configureSingleAxisEuler = (object: THREE.Object3D, axis: 'x' | 'y' | 'z', value: number) => {
  object.quaternion.identity();
  object.rotation.set(axis === 'x' ? value : 0, axis === 'y' ? value : 0, axis === 'z' ? value : 0);
};

const applyStaticRigRotation = (object: THREE.Object3D, joint: KinematicJoint, restQuaternion: THREE.Quaternion, value: number) => {
  const metadata = joint.evidence.find((item) => item.metadata)?.metadata;
  if (metadata?.useJointAxisVector === true) {
    const axis = new THREE.Vector3(...joint.axis);
    if (axis.lengthSq() > 1e-10) {
      object.quaternion.copy(restQuaternion).multiply(new THREE.Quaternion().setFromAxisAngle(axis.normalize(), value));
      return;
    }
  }
  configureSingleAxisEuler(object, localAxisKeyFromJoint(joint), value);
};

const conveyorBeltTexture = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 32;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#1f2427';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#3b4246';
    for (let x = -32; x < canvas.width + 32; x += 32) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x + 14, 0);
      context.lineTo(x + 46, canvas.height);
      context.lineTo(x + 32, canvas.height);
      context.closePath();
      context.fill();
    }
    context.fillStyle = '#f26a21';
    for (let x = -64; x < canvas.width + 64; x += 64) {
      context.fillRect(x, 0, 8, canvas.height);
    }
    context.strokeStyle = '#0f1214';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(0, 2);
    context.lineTo(canvas.width, 2);
    context.moveTo(0, canvas.height - 2);
    context.lineTo(canvas.width, canvas.height - 2);
    context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(9.5, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
};

const wrapRange = (value: number, min: number, span: number) => ((value - min) % span + span) % span + min;

const ensureConveyorBeltMarkers = (mesh: THREE.Mesh) => {
  const existing = mesh.userData.conveyorMotionMarkers as THREE.Group | undefined;
  if (existing) return existing;

  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  if (!box) return undefined;
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const span = Math.max(size.x, 0.2);
  const markerCount = Math.max(10, Math.min(22, Math.round(span / 0.12)));
  const group = new THREE.Group();
  group.name = 'conveyor_motion_markers';
  group.userData.nodeId = mesh.userData.nodeId;
  group.userData.trackMinX = box.min.x;
  group.userData.trackSpanX = span;

  const material = new THREE.MeshStandardMaterial({
    color: '#f26a21',
    emissive: '#f26a21',
    emissiveIntensity: 0.18,
    roughness: 0.48,
    metalness: 0.05,
  });
  const referenceMaterial = new THREE.MeshStandardMaterial({
    color: '#22d3ee',
    emissive: '#0891b2',
    emissiveIntensity: 0.45,
    roughness: 0.34,
    metalness: 0.05,
  });
  const markerGeometry = new THREE.BoxGeometry(Math.max(span / 28, 0.055), Math.max(size.y * 0.7, 0.014), Math.max(size.z * 0.94, 0.14));
  const referenceGeometry = new THREE.BoxGeometry(Math.max(span / 12, 0.16), Math.max(size.y * 0.9, 0.018), Math.max(size.z * 0.62, 0.12));
  const y = box.max.y + Math.max(size.y * 0.7, 0.018);
  for (let index = 0; index < markerCount; index += 1) {
    const marker = new THREE.Mesh(index === 0 ? referenceGeometry : markerGeometry, index === 0 ? referenceMaterial : material);
    marker.name = `belt_motion_mark_${index + 1}`;
    marker.position.set(box.min.x + (index * span) / markerCount, y, center.z);
    marker.userData.nodeId = mesh.userData.nodeId;
    group.add(marker);
  }
  mesh.add(group);
  mesh.userData.conveyorMotionMarkers = group;
  return group;
};

const applyConveyorParametricState = (assetRoot: THREE.Group, node: SceneNode) => {
  const geometry = node.geometry;
  if (!('kinematicGraph' in geometry) || !geometry.kinematicGraph || !('kinematicState' in geometry) || !geometry.kinematicState) return;
  if (!geometry.kinematicGraph.analysisVersion?.startsWith('conveyor-rig')) return;

  const rollerJoint = geometry.kinematicGraph.joints.find((joint) => joint.evidence[0]?.metadata?.order === 'R1') ?? geometry.kinematicGraph.joints.find((joint) => joint.name === 'R1_drive_roller');
  if (!rollerJoint) return;
  const rollerRadians = geometry.kinematicState.jointValues[rollerJoint.id] ?? geometry.kinematicState.homeJointValues[rollerJoint.id] ?? 0;
  const distanceMeters = -rollerRadians * 0.055;
  const beltOffset = -distanceMeters / 0.12;
  const travelMin = -1.4;
  const travelSpan = 2.8;
  let hasPartGroups = false;

  assetRoot.traverse((child) => {
    if (child.userData.nodeId === node.id && /^P\d+_part$/i.test(child.name)) hasPartGroups = true;
  });

  assetRoot.traverse((child) => {
    if (child.userData.nodeId !== node.id) return;
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && /belt_top/i.test(mesh.name)) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => {
        const standardMaterial = material as THREE.MeshStandardMaterial;
        if (!child.userData.conveyorMotionTexture) {
          child.userData.conveyorMotionTexture = conveyorBeltTexture();
        }
        if (standardMaterial.map !== child.userData.conveyorMotionTexture) {
          standardMaterial.map = child.userData.conveyorMotionTexture as THREE.Texture;
          standardMaterial.color.set('#ffffff');
          standardMaterial.needsUpdate = true;
        }
        const map = standardMaterial.map;
        if (!map) return;
        if (!child.userData.conveyorRestBeltOffset) child.userData.conveyorRestBeltOffset = map.offset.clone();
        const restOffset = child.userData.conveyorRestBeltOffset as THREE.Vector2;
        map.offset.x = restOffset.x + beltOffset * 0.37;
        map.needsUpdate = true;
      });
      const markerGroup = ensureConveyorBeltMarkers(mesh);
      if (markerGroup) {
        const trackMin = markerGroup.userData.trackMinX as number;
        const trackSpan = markerGroup.userData.trackSpanX as number;
        markerGroup.children.forEach((marker, index) => {
          const baseX = trackMin + (index * trackSpan) / Math.max(markerGroup.children.length, 1);
          marker.position.x = wrapRange(baseX + distanceMeters, trackMin, trackSpan);
        });
      }
    }

    if (/^P\d+_part$/i.test(child.name) || (!hasPartGroups && /^part_(box|tape)_\d+$/i.test(child.name))) {
      const restPosition = (child.userData.conveyorRestPartPosition as THREE.Vector3 | undefined) ?? child.position.clone();
      child.userData.conveyorRestPartPosition = restPosition;
      let x = restPosition.x + distanceMeters;
      x = ((x - travelMin) % travelSpan + travelSpan) % travelSpan + travelMin;
      child.position.set(x, restPosition.y, restPosition.z);
      child.updateMatrixWorld(true);
    }
  });
};

const applyImportedHierarchyKinematicState = (assetRoot: THREE.Group, node: SceneNode) => {
  const geometry = node.geometry;
  if (!('kinematicGraph' in geometry) || !geometry.kinematicGraph || !('kinematicState' in geometry) || !geometry.kinematicState) return;
  const state = geometry.kinematicState;
  const jointByName = new Map(geometry.kinematicGraph.joints.map((joint) => [joint.name, joint]));
  assetRoot.traverse((child) => {
    if (child.userData.nodeId !== node.id || !child.name || child.userData.freeDragging) return;
    const joint = jointByName.get(child.name);
    if (!joint || joint.type === 'fixed') return;
    const restRotation = (child.userData.hierarchicalKinematicRestRotation as THREE.Euler | undefined) ?? child.rotation.clone();
    const restPosition = (child.userData.hierarchicalKinematicRestPosition as THREE.Vector3 | undefined) ?? child.position.clone();
    child.userData.hierarchicalKinematicRestRotation = restRotation;
    child.userData.hierarchicalKinematicRestPosition = restPosition;
    child.rotation.set(restRotation.x, restRotation.y, restRotation.z);
    child.position.copy(restPosition);
    const axis = localAxisKeyFromJoint(joint);
    const value = state.jointValues[joint.id] ?? state.homeJointValues[joint.id] ?? 0;
    if (joint.type === 'prismatic') child.position[axis] = restPosition[axis] + value;
    else child.rotation[axis] = restRotation[axis] + value;
    child.updateMatrixWorld(true);
  });
  applyConveyorParametricState(assetRoot, node);
};

const applyIndustrialContractKinematicState = (assetRoot: THREE.Group, node: SceneNode) => {
  const geometry = node.geometry;
  if (!('kinematicGraph' in geometry) || !geometry.kinematicGraph || !('kinematicState' in geometry) || !geometry.kinematicState) return;
  const state = geometry.kinematicState;
  const jointByName = new Map(geometry.kinematicGraph.joints.map((joint) => [joint.name, joint]));
  const valueForJoint = (joint: KinematicJoint) => {
    if (joint.coupling) {
      const driverValue = state.jointValues[joint.coupling.driverJointId] ?? state.homeJointValues[joint.coupling.driverJointId] ?? 0;
      return driverValue * joint.coupling.multiplier + joint.coupling.offset;
    }
    return state.jointValues[joint.id] ?? state.homeJointValues[joint.id] ?? 0;
  };

  assetRoot.traverse((child) => {
    if (child.userData.nodeId !== node.id || !child.name || child.userData.freeDragging) return;
    const joint = jointByName.get(child.name);
    if (!joint || joint.type === 'fixed') return;
    const restRotation = (child.userData.industrialContractRestRotation as THREE.Euler | undefined) ?? child.rotation.clone();
    const restPosition = (child.userData.industrialContractRestPosition as THREE.Vector3 | undefined) ?? child.position.clone();
    child.userData.industrialContractRestRotation = restRotation;
    child.userData.industrialContractRestPosition = restPosition;
    child.rotation.set(restRotation.x, restRotation.y, restRotation.z);
    child.position.copy(restPosition);
    const axis = localAxisKeyFromJoint(joint);
    const value = clampJointValue(joint, valueForJoint(joint));
    if (joint.type === 'prismatic') child.position[axis] = restPosition[axis] + value;
    else child.rotation[axis] = restRotation[axis] + value;
    child.updateMatrixWorld(true);
  });
  applyConveyorParametricState(assetRoot, node);
};

const staticRigPivotName = (jointId: string) => `__static_rig_pivot_${jointId}`;

const objectBoundsCenterIn = (object: THREE.Object3D, frame: THREE.Object3D) => {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return undefined;
  const center = new THREE.Vector3();
  box.getCenter(center);
  return frame.worldToLocal(center);
};

const staticRigPreferredPivotObject = (joint: KinematicJoint, partObjectNames: string[], sourceObject: THREE.Object3D) => {
  const pivotObjectName = joint.evidence.find((item) => item.metadata)?.metadata?.pivotObjectName;
  if (typeof pivotObjectName === 'string') {
    const pivotObject = findDescendantByName(sourceObject, pivotObjectName);
    if (pivotObject) return pivotObject;
  }
  const preferred =
    /j1_/i.test(joint.name)
      ? [/j1_shell/i, /j1_seal/i, /turret_body/i, /shoulder_yoke/i]
      : /j2_/i.test(joint.name)
        ? [/j2_drum_body/i, /j2_drum_cap/i, /j2_cap/i, /shoulder_yoke/i]
        : /j3_/i.test(joint.name)
          ? [/j3_drum_body/i, /j3_drum_cap/i, /j3_cap/i, /elbow/i]
          : /j4_/i.test(joint.name)
            ? [/j4_drum_body/i, /j4_drum_cap/i, /j4_ring/i, /forearm_upper/i]
            : /j5_/i.test(joint.name)
              ? [/j5_drum_body/i, /j5_drum_cap/i, /wrist_yoke/i, /wrist_body/i]
              : /j6_/i.test(joint.name)
                ? [/wrist_3_shell/i, /tool_flange/i, /gripper_housing/i]
                : /finger_l/i.test(joint.name)
                  ? [/finger_carriage_L/i, /finger_jaw_L/i]
                  : /finger_r/i.test(joint.name)
                    ? [/finger_carriage_R/i, /finger_jaw_R/i]
                    : [];
  const orderedNames = [
    ...preferred.flatMap((pattern) => partObjectNames.filter((objectName) => pattern.test(objectName))),
    ...partObjectNames,
  ];
  for (const objectName of orderedNames) {
    const object = findDescendantByName(sourceObject, objectName);
    if (object) return object;
  }
  return undefined;
};

const staticRigPivotSourcePosition = (joint: KinematicJoint, partObjectNames: string[], sourceObject: THREE.Object3D) => {
  const metadata = joint.evidence.find((item) => item.metadata)?.metadata;
  const sourceSchema = typeof metadata?.sourceSchema === 'string' ? metadata.sourceSchema : '';
  if (/^legacy-robot-rig\//i.test(sourceSchema) && joint.origin?.position?.every((value) => Number.isFinite(value))) {
    return new THREE.Vector3(...joint.origin.position);
  }
  const preferred = staticRigPreferredPivotObject(joint, partObjectNames, sourceObject);
  const center = preferred ? objectBoundsCenterIn(preferred, sourceObject) : undefined;
  if (center) return center;
  const box = new THREE.Box3();
  partObjectNames.forEach((objectName) => {
    const object = findDescendantByName(sourceObject, objectName);
    if (object) box.expandByObject(object);
  });
  if (!box.isEmpty()) {
    const fallback = new THREE.Vector3();
    box.getCenter(fallback);
    return sourceObject.worldToLocal(fallback);
  }
  return new THREE.Vector3(...joint.origin.position);
};

const buildStaticRigHierarchy = (assetRoot: THREE.Group, node: SceneNode) => {
  const geometry = node.geometry;
  if (!('kinematicGraph' in geometry) || !geometry.kinematicGraph) return undefined;
  const nodeObject = assetRoot.children.find((child) => child.userData.nodeId === node.id);
  const sourceObject = node.geometry.kind === 'serialized-object' ? nodeObject : (nodeObject?.children[0] ?? nodeObject);
  if (!sourceObject) return undefined;

  const graph = geometry.kinematicGraph;
  const hierarchyKey = `${node.id}:${graph.analysisVersion}:${graph.joints.length}:${graph.parts.length}`;
  if (sourceObject.userData.staticRigHierarchyKey !== hierarchyKey) {
    const pivots = new Map<string, THREE.Group>();
    const partById = new Map(graph.parts.map((part) => [part.id, part]));
    sourceObject.updateMatrixWorld(true);

    graph.joints.forEach((joint) => {
      const part = partById.get(joint.childPartId);
      const pivotPosition = staticRigPivotSourcePosition(joint, part?.meshObjectIds ?? [], sourceObject);
      const pivot = new THREE.Group();
      pivot.name = staticRigPivotName(joint.id);
      pivot.userData.nodeId = node.id;
      pivot.userData.staticRigPivot = true;
      pivot.userData.jointId = joint.id;
      pivot.position.copy(pivotPosition);
      pivot.updateMatrixWorld(true);
      sourceObject.add(pivot);
      pivots.set(joint.id, pivot);
    });

    graph.joints.forEach((joint) => {
      const parentJoint = graph.joints.find((candidate) => candidate.childPartId === joint.parentPartId);
      const parentPivot = parentJoint ? pivots.get(parentJoint.id) : undefined;
      const pivot = pivots.get(joint.id);
      if (parentPivot && pivot) parentPivot.attach(pivot);
    });

    graph.joints.forEach((joint) => {
      const pivot = pivots.get(joint.id);
      const part = partById.get(joint.childPartId);
      if (!pivot || !part) return;
      part.meshObjectIds.forEach((objectName) => {
        const object = findDescendantByName(sourceObject, objectName);
        if (!object || object === pivot || object.userData.staticRigPivot) return;
        pivot.attach(object);
      });
    });

    pivots.forEach((pivot) => {
      pivot.userData.staticRigRestPosition = pivot.position.clone();
      pivot.userData.staticRigRestQuaternion = pivot.quaternion.clone();
      pivot.userData.staticRigRestScale = pivot.scale.clone();
    });
    sourceObject.userData.staticRigHierarchyKey = hierarchyKey;
  }

  return sourceObject;
};

const applyStaticRigHierarchyKinematicState = (assetRoot: THREE.Group, node: SceneNode) => {
  const geometry = node.geometry;
  if (!('kinematicGraph' in geometry) || !geometry.kinematicGraph || !('kinematicState' in geometry) || !geometry.kinematicState) return;
  const sourceObject = buildStaticRigHierarchy(assetRoot, node);
  if (!sourceObject) return;
  const graph = geometry.kinematicGraph;
  const state = geometry.kinematicState;

  graph.joints.forEach((joint) => {
    const pivot = findDescendantByName(sourceObject, staticRigPivotName(joint.id));
    if (!pivot) return;
    const restPosition = (pivot.userData.staticRigRestPosition as THREE.Vector3 | undefined) ?? pivot.position.clone();
    const restQuaternion = (pivot.userData.staticRigRestQuaternion as THREE.Quaternion | undefined) ?? pivot.quaternion.clone();
    const restScale = (pivot.userData.staticRigRestScale as THREE.Vector3 | undefined) ?? pivot.scale.clone();
    pivot.position.copy(restPosition);
    pivot.quaternion.copy(restQuaternion);
    pivot.scale.copy(restScale);

    if (joint.type === 'fixed') return;
    const axis = localAxisKeyFromJoint(joint);
    const rawValue = state.jointValues[joint.id] ?? state.homeJointValues[joint.id] ?? 0;
    const value = clampJointValue(joint, rawValue);
    if (joint.type === 'prismatic') {
      pivot.position[axis] = restPosition[axis] + value;
    } else {
      applyStaticRigRotation(pivot, joint, restQuaternion, value);
    }
    pivot.updateMatrixWorld(true);
  });
};

const applyKinematicGraphState = (assetRoot: THREE.Group, document: AssetDocument) => {
  const assetRootInverse = assetRoot.matrixWorld.clone().invert();
  document.nodes.forEach((node) => {
    if (!('kinematicGraph' in node.geometry) || !node.geometry.kinematicGraph || !node.geometry.kinematicState) return;
    if (usesImportedHierarchyKinematics(node)) {
      applyImportedHierarchyKinematicState(assetRoot, node);
      return;
    }
    if (usesStaticRigHierarchyKinematics(node)) {
      applyStaticRigHierarchyKinematicState(assetRoot, node);
      return;
    }
    if (usesIndustrialContractKinematics(node)) {
      applyIndustrialContractKinematicState(assetRoot, node);
      return;
    }
    const nodeObject = assetRoot.children.find((child) => child.userData.nodeId === node.id);
    const sourceObject = node.geometry.kind === 'serialized-object' ? nodeObject : (nodeObject?.children[0] ?? nodeObject);
    sourceObject?.updateMatrixWorld(true);
    const sourceToAssetMatrix = sourceObject ? assetRootInverse.clone().multiply(sourceObject.matrixWorld) : new THREE.Matrix4();
    const assetToSourceMatrix = sourceToAssetMatrix.clone().invert();
    const poses = evaluateForwardKinematics(node.geometry.kinematicGraph, node.geometry.kinematicState);
    const partsByObjectName = new Map<string, string>();
    node.geometry.kinematicGraph.parts.forEach((part) => {
      part.meshObjectIds.forEach((objectName) => partsByObjectName.set(objectName, part.id));
    });

    assetRoot.traverse((child) => {
      if (child.userData.nodeId !== node.id || !child.name || child.userData.freeDragging) return;
      const partId = partsByObjectName.get(child.name);
      if (!partId) return;
      const pose = poses[partId];
      if (!pose) return;

      child.updateMatrixWorld(true);
      if (!child.userData.kinematicRestAssetMatrix) {
        child.userData.kinematicRestAssetMatrix = assetRootInverse.clone().multiply(child.matrixWorld);
      }

      const restAssetMatrix = child.userData.kinematicRestAssetMatrix as THREE.Matrix4;
      const sourcePoseMatrix = matrixFromEvaluatedPose(pose.matrix);
      const assetPoseMatrix = sourceToAssetMatrix.clone().multiply(sourcePoseMatrix).multiply(assetToSourceMatrix);
      const nextAssetMatrix = assetPoseMatrix.multiply(restAssetMatrix);
      const parentAssetMatrix = child.parent ? assetRootInverse.clone().multiply(child.parent.matrixWorld) : new THREE.Matrix4();
      const nextLocalMatrix = parentAssetMatrix.clone().invert().multiply(nextAssetMatrix);
      nextLocalMatrix.decompose(child.position, child.quaternion, child.scale);
      child.updateMatrixWorld(true);
    });
  });
};

const applyRuntimeMotionDemo = (
  assetRoot: THREE.Group,
  document: AssetDocument,
  motionDemoNodeId: string | undefined,
  motionTrainingPreview: MotionTrainingPreview | undefined,
  elapsed: number,
) => {
  document.nodes.forEach((node) => {
    const active = node.id === motionDemoNodeId;
    if ('kinematicGraph' in node.geometry && node.geometry.kinematicState && node.geometry.kinematicGraph) {
      if (!active) return;
      const clip =
        node.geometry.kinematicGraph.motionClips?.find((candidate) => /pick|place|ciclo/i.test(candidate.name)) ??
        node.geometry.kinematicGraph.motionClips?.[0];
      if (!clip) return;
      const runtimeNode: SceneNode = {
        ...node,
        geometry: {
          ...node.geometry,
          kinematicState: {
            homeJointValues: { ...node.geometry.kinematicState.homeJointValues },
            jointValues: sampleKinematicMotionClip(clip, elapsed),
          },
        },
      };
      if (usesImportedHierarchyKinematics(runtimeNode)) {
        applyImportedHierarchyKinematicState(assetRoot, runtimeNode);
      } else if (usesStaticRigHierarchyKinematics(runtimeNode)) {
        applyStaticRigHierarchyKinematicState(assetRoot, runtimeNode);
      } else if (usesIndustrialContractKinematics(runtimeNode)) {
        applyIndustrialContractKinematicState(assetRoot, runtimeNode);
      } else {
        applyKinematicGraphState(assetRoot, { ...document, nodes: [runtimeNode] });
      }
      return;
    }
    if (node.geometry.kind !== 'imported-model') return;
    const poseByName = new Map(node.geometry.joints.map((joint, index) => [joint.name, { joint, index }]));
    const freePartNames = new Set((node.geometry.freePartTransforms ?? []).map((partTransform) => partTransform.objectName));
    const validated = orderedValidatedMotions(node.geometry.validatedMotions);
    const activeValidatedMotion =
      active && validated.length ? validated[Math.floor((elapsed / 1.65) % validated.length)] : undefined;

    assetRoot.traverse((child) => {
      if (child.userData.nodeId !== node.id) return;
      if (child.userData.freeDragging || freePartNames.has(child.name)) return;
      const pose = poseByName.get(child.name);
      if (!pose) return;

      if (motionTrainingPreview?.nodeId === node.id && motionTrainingPreview.jointName === pose.joint.name) {
        const value = previewMotionValue(motionTrainingPreview.min, motionTrainingPreview.max, motionTrainingPreview.amplitude, elapsed);
        applyLogicalJointPose(
          child,
          {
            ...pose.joint,
            motionKind: motionTrainingPreview.motionKind,
            axis: motionTrainingPreview.axis,
          },
          value,
        );
      } else if (activeValidatedMotion?.jointName === pose.joint.name) {
        const value = previewMotionValue(activeValidatedMotion.min, activeValidatedMotion.max, activeValidatedMotion.amplitude, elapsed);
        applyLogicalJointPose(
          child,
          {
            ...pose.joint,
            motionKind: activeValidatedMotion.motionKind,
            axis: activeValidatedMotion.axis,
          },
          value,
        );
      } else if (active && !validated.length) {
        const value = logicalMotionValue(pose.joint, pose.index, elapsed);
        applyLogicalJointPose(child, pose.joint, value);
      } else {
        applyLogicalJointPose(child, pose.joint);
      }
    });
  });
};

const sampleIndustrialCellJointValues = (node: SceneNode, elapsed: number): Record<string, number> | undefined => {
  if (!('kinematicGraph' in node.geometry) || !node.geometry.kinematicGraph) return undefined;
  const cycle = ((elapsed % 12) + 12) % 12;
  const graph = node.geometry.kinematicGraph;
  const home = node.geometry.kinematicState?.homeJointValues ?? {};
  const generatorId = industrialCellGeneratorId(node);
  const clipByName = (pattern: RegExp) => graph.motionClips?.find((clip) => pattern.test(clip.name));

  if (generatorId === 'industrial-gantry-5axis') {
    const clip = clipByName(/ciclo|descarga/i);
    return clip ? sampleKinematicMotionClip(clip, cycle) : undefined;
  }

  if (generatorId === 'industrial-inspection-machine') {
    const clip = clipByName(/inspeccion/i);
    const values = clip ? sampleKinematicMotionClip(clip, Math.max(0, cycle - 5.8)) : {};
    return { ...home, ...values, M4: -(elapsed * 7.2) };
  }

  if (generatorId === 'industrial-conveyor-segment') {
    const label = /Output|B\b/i.test(node.name) ? 'B' : 'A';
    const start = label === 'A' ? 4.8 : 8.6;
    const runTime = cycle >= start ? cycle - start : 0;
    const roller = -runTime * 5.45;
    return {
      ...home,
      [`${label}_R1`]: roller,
      [`${label}_S1`]: cycle > start + 1.1 && cycle < start + 2.7 ? 0 : -0.11,
    };
  }

  if (generatorId === 'industrial-operator') {
    const clip = clipByName(/panel/i);
    if (!clip) return undefined;
    return cycle >= 6.9 ? sampleKinematicMotionClip(clip, cycle - 6.9) : home;
  }

  if (generatorId === 'industrial-cargo-box') {
    const clip = clipByName(/tapa|lid/i);
    return clip && /B1/i.test(node.name) ? sampleKinematicMotionClip(clip, Math.max(0, cycle - 9.2)) : home;
  }

  return undefined;
};

const industrialCargoPosition = (node: SceneNode, elapsed: number, restPosition: THREE.Vector3) => {
  const cycle = ((elapsed % 12) + 12) % 12;
  const next = restPosition.clone();
  if (/Loose Box/i.test(node.name)) {
    return next;
  }
  const phase = /B1/i.test(node.name) ? cycle - 8.6 : cycle - 4.8;
  if (phase >= 0) {
    if (/B1/i.test(node.name)) next.x = 1.02 + Math.min(phase * 0.42, 2.7);
    else next.x = -3.2 + Math.min(phase * 0.5, 3.85);
  }
  next.y = 0.86;
  next.z = /A2/i.test(node.name) ? 0.18 : /A1/i.test(node.name) ? -0.18 : 0;
  return next;
};

const localPointFromWorld = (assetRoot: THREE.Group, worldPoint: THREE.Vector3) => assetRoot.worldToLocal(worldPoint.clone());

const isIndustrialCargoBoxNode = (node: SceneNode) => industrialCellGeneratorId(node) === 'industrial-cargo-box';

const isLooseIndustrialCargoBox = (node: SceneNode) => isIndustrialCargoBoxNode(node) && /Loose Box/i.test(node.name);

const findIndustrialGantryGrip = (assetRoot: THREE.Group) => {
  const grip = findDescendantByName(assetRoot, 'G4_head_roll') ?? findDescendantByName(assetRoot, 'gantry_grip_plate');
  if (!grip) return undefined;
  const worldPosition = new THREE.Vector3();
  grip.getWorldPosition(worldPosition);
  return { object: grip, worldPosition };
};

const intersectsOrTouchesGrip = (grip: THREE.Object3D, cargo: THREE.Object3D, maxDistance = 0.52) => {
  const gripBox = new THREE.Box3().setFromObject(grip);
  const cargoBox = new THREE.Box3().setFromObject(cargo);
  if (!gripBox.isEmpty() && !cargoBox.isEmpty() && gripBox.intersectsBox(cargoBox)) return true;
  const gripCenter = new THREE.Vector3();
  const cargoCenter = new THREE.Vector3();
  gripBox.getCenter(gripCenter);
  cargoBox.getCenter(cargoCenter);
  return gripCenter.distanceTo(cargoCenter) <= maxDistance;
};

const clearIndustrialCargoLifecycle = (nodeObject: THREE.Object3D) => {
  nodeObject.userData.industrialCellPicked = false;
  nodeObject.userData.industrialCellTouched = false;
  nodeObject.userData.industrialCellReleased = false;
  delete nodeObject.userData.industrialCellGripOffset;
};

const applyIndustrialPickAndPlaceCargo = (assetRoot: THREE.Group, node: SceneNode, nodeObject: THREE.Object3D, elapsed: number) => {
  const cycle = ((elapsed % 12) + 12) % 12;
  const grip = findIndustrialGantryGrip(assetRoot);
  const contactWindow = cycle >= 2.7 && cycle < 3.8;
  const carryWindow = cycle >= 3.35 && cycle < 8.9;
  const releaseWindow = cycle >= 8.9;
  const carriedNodeId = assetRoot.userData.industrialCellCarriedCargoNodeId as string | undefined;
  const isThisCargoCarried = carriedNodeId === node.id;
  const previousCycle = nodeObject.userData.industrialCellCyclePhase as number | undefined;
  if (previousCycle !== undefined && cycle < previousCycle) {
    if (isThisCargoCarried) delete assetRoot.userData.industrialCellCarriedCargoNodeId;
    clearIndustrialCargoLifecycle(nodeObject);
  }
  nodeObject.userData.industrialCellCyclePhase = cycle;

  if (!nodeObject.userData.industrialCellPicked && !nodeObject.userData.industrialCellReleased && grip && !carriedNodeId && contactWindow && intersectsOrTouchesGrip(grip.object, nodeObject)) {
    nodeObject.userData.industrialCellTouched = true;
    const cargoWorld = new THREE.Vector3();
    nodeObject.getWorldPosition(cargoWorld);
    const offset = cargoWorld.sub(grip.worldPosition);
    nodeObject.userData.industrialCellGripOffset = [offset.x, offset.y, offset.z];
  }
  if (carryWindow && nodeObject.userData.industrialCellTouched && (!carriedNodeId || isThisCargoCarried)) {
    nodeObject.userData.industrialCellPicked = true;
    assetRoot.userData.industrialCellCarriedCargoNodeId = node.id;
  }

  if (releaseWindow && (nodeObject.userData.industrialCellPicked || isThisCargoCarried)) {
    nodeObject.userData.industrialCellReleased = true;
    nodeObject.userData.industrialCellPicked = false;
    if (isThisCargoCarried) delete assetRoot.userData.industrialCellCarriedCargoNodeId;
  }

  if (grip && (nodeObject.userData.industrialCellPicked || isThisCargoCarried)) {
    const storedOffset = nodeObject.userData.industrialCellGripOffset as [number, number, number] | undefined;
    const offset = storedOffset ? new THREE.Vector3(...storedOffset) : new THREE.Vector3(0, -0.24, 0);
    const carried = localPointFromWorld(assetRoot, grip.worldPosition.clone().add(offset));
    nodeObject.position.copy(carried);
    nodeObject.rotation.y = node.transform.rotation[1];
    nodeObject.updateMatrixWorld(true);
    return;
  }

  if (nodeObject.userData.industrialCellReleased) {
    const releasePhase = Math.max(0, cycle - 8.9);
    nodeObject.position.set(-2.92 + Math.min(releasePhase * 0.5, 2.1), 0.86, 0);
    nodeObject.updateMatrixWorld(true);
    return;
  }
};

const applyIndustrialCellCycleDemo = (assetRoot: THREE.Group, document: AssetDocument, elapsed: number) => {
  document.nodes.forEach((node) => {
    if (!isIndustrialGeneratedNode(node)) return;
    const values = sampleIndustrialCellJointValues(node, elapsed);
    if (values && 'kinematicGraph' in node.geometry && node.geometry.kinematicGraph) {
      const runtimeNode: SceneNode = {
        ...node,
        geometry: {
          ...node.geometry,
          kinematicState: {
            homeJointValues: { ...(node.geometry.kinematicState?.homeJointValues ?? {}) },
            jointValues: values,
          },
        },
      };
      applyIndustrialContractKinematicState(assetRoot, runtimeNode);
    }

  });

  document.nodes.forEach((node) => {
    if (!isIndustrialCargoBoxNode(node)) return;
    const nodeObject = assetRoot.children.find((child) => child.userData.nodeId === node.id);
    if (!nodeObject) return;
    const isLoose = isLooseIndustrialCargoBox(node);
    const restPosition =
      isLoose && !nodeObject.userData.industrialCellPicked && !nodeObject.userData.industrialCellTouched && !nodeObject.userData.industrialCellReleased
        ? nodeObject.position.clone()
        : (nodeObject.userData.industrialCellRestPosition as THREE.Vector3 | undefined) ?? nodeObject.position.clone();
    nodeObject.userData.industrialCellRestPosition = restPosition;
    if (isLoose) {
      applyIndustrialPickAndPlaceCargo(assetRoot, node, nodeObject, elapsed);
      return;
    }
    const fallback = industrialCargoPosition(node, elapsed, restPosition);
    nodeObject.position.copy(fallback);
    nodeObject.updateMatrixWorld(true);
  });
};

const renderStructureSignature = (document: AssetDocument) =>
  JSON.stringify({
    nodes: document.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      visible: node.visible,
      locked: node.locked,
      transform: node.transform,
      material: node.material,
      geometry:
        node.geometry.kind === 'imported-model'
          ? {
              kind: node.geometry.kind,
              assetName: node.geometry.assetName,
              assetDataUrlLength: node.geometry.assetDataUrl.length,
              sourceFormat: node.geometry.sourceFormat,
              importScale: node.geometry.importScale,
              importOffset: node.geometry.importOffset,
              jointStructure: node.geometry.joints.map((joint) => ({
                name: joint.name,
                axis: joint.axis,
                motionKind: joint.motionKind,
                cursorControl: joint.cursorControl,
                min: joint.min,
                max: joint.max,
              })),
              validatedMotionStructure: node.geometry.validatedMotions?.map((motion) => ({
                id: motion.id,
                jointName: motion.jointName,
                motionKind: motion.motionKind,
                axis: motion.axis,
                min: motion.min,
                max: motion.max,
                amplitude: motion.amplitude,
                order: motion.order,
              })),
              freePartTransforms: node.geometry.freePartTransforms,
              partMaterials: node.geometry.partMaterials,
              isolatedObjectNames: node.geometry.isolatedObjectNames,
              partObjectNames: node.geometry.partObjectNames,
              kinematicGraphStructure: node.geometry.kinematicGraph
                ? {
                    rootPartId: node.geometry.kinematicGraph.rootPartId,
                    partCount: node.geometry.kinematicGraph.parts.length,
                    joints: node.geometry.kinematicGraph.joints.map((joint) => ({
                      id: joint.id,
                      parentPartId: joint.parentPartId,
                      childPartId: joint.childPartId,
                      type: joint.type,
                      origin: joint.origin,
                      axis: joint.axis,
                      limits: joint.limits,
                      status: joint.status,
                    })),
                  }
                : undefined,
            }
          : node.geometry.kind === 'serialized-object'
            ? {
                kind: node.geometry.kind,
                assetName: node.geometry.assetName,
                originalBounds: node.geometry.originalBounds,
                normalizedBounds: node.geometry.normalizedBounds,
                functionalComponentId: node.geometry.functionalComponent?.id,
                kinematicGraphStructure: node.geometry.kinematicGraph
                  ? {
                      rootPartId: node.geometry.kinematicGraph.rootPartId,
                      partCount: node.geometry.kinematicGraph.parts.length,
                      joints: node.geometry.kinematicGraph.joints.map((joint) => ({
                        id: joint.id,
                        parentPartId: joint.parentPartId,
                        childPartId: joint.childPartId,
                        type: joint.type,
                        origin: joint.origin,
                        axis: joint.axis,
                        motionProfile: joint.motionProfile,
                        motionPlane: joint.motionPlane,
                        drivenPoint: joint.drivenPoint,
                        limits: joint.limits,
                        status: joint.status,
                      })),
                    }
                  : undefined,
              }
          : node.geometry,
    })),
  });

export const ThreeViewport = ({
  document,
  tool,
  partEditMode,
  snapEnabled,
  viewportNotice,
  kinematicEditTarget,
  motionDemoNodeId,
  industrialCellDemoActive = false,
  robotCursorGuideNodeId,
  motionTrainingPreview,
  onSelect,
  onTransformCommit,
  onImportedPartTransformsCommit,
  onJointPoseChange,
  onKinematicPointPick,
  onKinematicAxisChange,
  onRobotCursorGuide,
  onPieceReferenceCenterEstimate,
  onPartSelectionChange,
  onNodeContextMenu,
  onNodeDoubleClick,
  onStatsChange,
}: ThreeViewportProps) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [liveStats, setLiveStats] = useState<ViewportStats>({ fps: 0, objects: document.nodes.length, triangles: 0, cpuPercent: 0 });
  const documentRef = useRef(document);
  const toolRef = useRef(tool);
  const partEditModeRef = useRef(partEditMode);
  const kinematicEditTargetRef = useRef(kinematicEditTarget);
  const motionDemoNodeIdRef = useRef(motionDemoNodeId);
  const industrialCellDemoActiveRef = useRef(industrialCellDemoActive);
  const robotCursorGuideNodeIdRef = useRef(robotCursorGuideNodeId);
  const motionTrainingPreviewRef = useRef(motionTrainingPreview);
  const onSelectRef = useRef(onSelect);
  const onTransformCommitRef = useRef(onTransformCommit);
  const onImportedPartTransformsCommitRef = useRef(onImportedPartTransformsCommit);
  const onJointPoseChangeRef = useRef(onJointPoseChange);
  const onKinematicPointPickRef = useRef(onKinematicPointPick);
  const onKinematicAxisChangeRef = useRef(onKinematicAxisChange);
  const onRobotCursorGuideRef = useRef(onRobotCursorGuide);
  const onPieceReferenceCenterEstimateRef = useRef(onPieceReferenceCenterEstimate);
  const onPartSelectionChangeRef = useRef(onPartSelectionChange);
  const onNodeContextMenuRef = useRef(onNodeContextMenu);
  const onNodeDoubleClickRef = useRef(onNodeDoubleClick);
  const onStatsChangeRef = useRef(onStatsChange);
  const renderStructureSignatureRef = useRef<string>();
  const estimatedReferenceNodeIdsRef = useRef<Set<string>>(new Set());
  const jointDragRef = useRef<{
    pointerId: number;
    nodeId: string;
    jointName: string;
    motionKind: JointMotionKind;
    cursorControl: CursorMotionControl;
    min: number;
    max: number;
    startX: number;
    startY: number;
    startValue: number;
    pivotClient: { x: number; y: number };
    startAngle?: number;
    axisClient?: { x: number; y: number };
    startAxisDistance?: number;
  }>();
  const objectDragRef = useRef<{
    pointerId: number;
    plane: THREE.Plane;
    startCursorPoint: THREE.Vector3;
    items: Array<{
      nodeId: string;
      object: THREE.Object3D;
      objectName?: string;
      startWorldPosition: THREE.Vector3;
    }>;
  }>();
  const axisGizmoDragRef = useRef<{
    pointerId: number;
    plane: THREE.Plane;
    origin: THREE.Vector3;
    helperLength: number;
    nodeId: string;
    jointId: string;
  }>();
  const robotCursorGuideDragRef = useRef<{
    pointerId: number;
    nodeId: string;
    plane: THREE.Plane;
  }>();
  const selectedPartKeysRef = useRef<Set<string>>(new Set());
  const captureModeRef = useRef(false);
  const runtimeRef = useRef<{
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
    scene: THREE.Scene;
    raycaster: THREE.Raycaster;
    pointer: THREE.Vector2;
    orbit: OrbitControls;
    transform: TransformControls;
    assetRoot: THREE.Group;
    selectionBox: THREE.BoxHelper;
    selectedPartBoxes: THREE.BoxHelper[];
    partTransformGroup: THREE.Group;
    kinematicHelperGroup: THREE.Group;
    kinematicAxisHandle: THREE.Mesh;
    partTransformItems: Array<{
      nodeId: string;
      objectName: string;
      object: THREE.Object3D;
      originalParent: THREE.Object3D | null;
    }>;
    animationId: number;
    lastFrame: number;
    lastFrameTime: number;
    lastStatsUpdate: number;
    frames: number;
    fps: number;
    cpuPercent: number;
  } | null>(null);

  useEffect(() => {
    documentRef.current = document;
    toolRef.current = tool;
    partEditModeRef.current = partEditMode;
    kinematicEditTargetRef.current = kinematicEditTarget;
    motionDemoNodeIdRef.current = motionDemoNodeId;
    industrialCellDemoActiveRef.current = industrialCellDemoActive;
    robotCursorGuideNodeIdRef.current = robotCursorGuideNodeId;
    motionTrainingPreviewRef.current = motionTrainingPreview;
  }, [document, tool, partEditMode, kinematicEditTarget, motionDemoNodeId, industrialCellDemoActive, robotCursorGuideNodeId, motionTrainingPreview]);

  useEffect(() => {
    onSelectRef.current = onSelect;
    onTransformCommitRef.current = onTransformCommit;
    onImportedPartTransformsCommitRef.current = onImportedPartTransformsCommit;
    onJointPoseChangeRef.current = onJointPoseChange;
    onKinematicPointPickRef.current = onKinematicPointPick;
    onKinematicAxisChangeRef.current = onKinematicAxisChange;
    onRobotCursorGuideRef.current = onRobotCursorGuide;
    onPieceReferenceCenterEstimateRef.current = onPieceReferenceCenterEstimate;
    onPartSelectionChangeRef.current = onPartSelectionChange;
    onNodeContextMenuRef.current = onNodeContextMenu;
    onNodeDoubleClickRef.current = onNodeDoubleClick;
    onStatsChangeRef.current = onStatsChange;
  }, [
    onSelect,
    onTransformCommit,
    onImportedPartTransformsCommit,
    onJointPoseChange,
    onKinematicPointPick,
    onKinematicAxisChange,
    onRobotCursorGuide,
    onPieceReferenceCenterEstimate,
    onPartSelectionChange,
    onNodeContextMenu,
    onNodeDoubleClick,
    onStatsChange,
  ]);

  useEffect(() => {
    if (!hostRef.current || runtimeRef.current) return;

    const host = hostRef.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.setClearColor('#202326');
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, host.clientWidth / host.clientHeight, 0.1, 200);
    camera.position.set(4.6, 3.8, 5.4);

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.target.set(0, 0.7, 0);

    const transform = new TransformControls(camera, renderer.domElement);
    scene.add(transform.getHelper());

    scene.add(new THREE.HemisphereLight('#ffffff', '#47515a', 1.8));
    const keyLight = new THREE.DirectionalLight('#ffffff', 2.6);
    keyLight.position.set(4, 7, 3);
    scene.add(keyLight);
    scene.add(new THREE.GridHelper(20, 20, '#56606a', '#343a40'));

    const assetRoot = new THREE.Group();
    scene.add(assetRoot);
    const partTransformGroup = new THREE.Group();
    partTransformGroup.name = 'Selected Parts Transform';
    scene.add(partTransformGroup);
    const kinematicHelperGroup = new THREE.Group();
    kinematicHelperGroup.name = 'Kinematic Authoring Helpers';
    scene.add(kinematicHelperGroup);
    const kinematicAxisHandle = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 16, 12),
      new THREE.MeshBasicMaterial({ color: '#ffd23f', depthTest: false }),
    );
    kinematicAxisHandle.name = 'Kinematic Axis Handle';
    kinematicAxisHandle.renderOrder = 20;
    kinematicAxisHandle.visible = false;
    scene.add(kinematicAxisHandle);
    const selectionBox = new THREE.BoxHelper(new THREE.Object3D(), '#30d6c8');
    selectionBox.visible = false;
    scene.add(selectionBox);
    const selectedPartBoxes: THREE.BoxHelper[] = [];

    transform.addEventListener('dragging-changed', (event) => {
      orbit.enabled = !event.value;
    });

    transform.addEventListener('mouseUp', () => {
      const runtime = runtimeRef.current;
      const attached = transform.object;
      if (runtime?.partTransformGroup && attached === runtime.partTransformGroup) {
        const updates = runtime.partTransformItems.map((item) => {
          item.originalParent?.attach(item.object);
          item.object.updateMatrixWorld(true);
          return {
            nodeId: item.nodeId,
            objectName: item.objectName,
            transform: toTransform(item.object),
          };
        });
        runtime.partTransformItems = [];
        runtime.partTransformGroup.position.set(0, 0, 0);
        runtime.partTransformGroup.rotation.set(0, 0, 0);
        runtime.partTransformGroup.scale.set(1, 1, 1);
        runtime.partTransformGroup.clear();
        transform.detach();
        if (updates.length) onImportedPartTransformsCommitRef.current(updates);
        return;
      }

      const nodeId = attached?.userData.nodeId as string | undefined;
      if (attached && nodeId) {
        onTransformCommitRef.current(nodeId, toTransform(attached));
      }
    });

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const updatePointer = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const findJointObject = (root: THREE.Object3D, nodeId: string, jointName: string) => {
      let result: THREE.Object3D | undefined;
      root.traverse((candidate) => {
        if (!result && candidate.userData.nodeId === nodeId && candidate.name === jointName) {
          result = candidate;
        }
      });
      return result;
    };

    const findPickedJoint = (object: THREE.Object3D | undefined, point?: THREE.Vector3) => {
      let current: THREE.Object3D | null | undefined = object;
      const nodeId = current?.userData.nodeId as string | undefined;
      const node = documentRef.current.nodes.find((item) => item.id === nodeId);
      if (!node || node.geometry.kind !== 'imported-model') return undefined;

      const jointByName = new Map(node.geometry.joints.map((joint) => [joint.name, joint]));
      while (current && current !== assetRoot) {
        const exact = jointByName.get(current.name);
        if (exact) return { node, joint: exact, object: current };
        current = current.parent;
      }

      const hitName = object?.name ?? '';
      const contained = node.geometry.joints
        .filter((joint) => hitName.includes(joint.name))
        .sort((a, b) => b.name.length - a.name.length)[0];
      if (contained) return { node, joint: contained, object: findJointObject(assetRoot, node.id, contained.name) ?? object };

      return undefined;
    };

    const findKinematicContext = (object: THREE.Object3D | undefined) => {
      let current: THREE.Object3D | null | undefined = object;
      const nodeId = current?.userData.nodeId as string | undefined;
      const node = documentRef.current.nodes.find((item) => item.id === nodeId);
      if (!node || !('kinematicGraph' in node.geometry) || !node.geometry.kinematicGraph) return undefined;

      let objectName = object?.name;
      while (current && current !== assetRoot) {
        if (current.userData.nodeId === nodeId && current.name && current.name !== node.name) {
          objectName = current.name;
          break;
        }
        current = current.parent;
      }

      const graph = node.geometry.kinematicGraph;
      const part = objectName ? graph.parts.find((candidate) => candidate.meshObjectIds.includes(objectName)) : undefined;
      const jointIds = part
        ? graph.joints
            .filter((joint) => joint.childPartId === part.id || joint.parentPartId === part.id)
            .map((joint) => joint.id)
        : [];
      return { node, objectName, jointIds, jointId: jointIds[0] };
    };

    const findNodeObject = (nodeId: string | undefined) => (nodeId ? assetRoot.children.find((child) => child.userData.nodeId === nodeId) : undefined);

    const partKey = (nodeId: string, objectName: string) => `${nodeId}::${objectName}`;

    const findSourceObject = (nodeId: string | undefined) => {
      const nodeObject = findNodeObject(nodeId);
      const node = documentRef.current.nodes.find((item) => item.id === nodeId);
      if (node?.geometry.kind === 'serialized-object') return nodeObject ?? assetRoot;
      return nodeObject?.children[0] ?? nodeObject ?? assetRoot;
    };

    const sourcePointFromWorld = (nodeId: string | undefined, worldPoint: THREE.Vector3) => findSourceObject(nodeId).worldToLocal(worldPoint.clone());

    const sourcePointToWorld = (nodeId: string | undefined, sourcePoint: [number, number, number]) =>
      findSourceObject(nodeId).localToWorld(new THREE.Vector3(...sourcePoint));

    const sourceDirectionToWorld = (nodeId: string | undefined, sourceDirection: [number, number, number]) => {
      const frame = findSourceObject(nodeId);
      const origin = frame.localToWorld(new THREE.Vector3(0, 0, 0));
      const end = frame.localToWorld(new THREE.Vector3(...normalizeTuple(sourceDirection)));
      const direction = end.sub(origin);
      return direction.lengthSq() > 0.000001 ? direction.normalize() : new THREE.Vector3(1, 0, 0);
    };

    const worldDirectionToSource = (nodeId: string | undefined, worldDirection: THREE.Vector3) => {
      const frame = findSourceObject(nodeId);
      const worldOrigin = new THREE.Vector3();
      const worldEnd = worldDirection.clone().normalize();
      const sourceOrigin = frame.worldToLocal(worldOrigin.clone());
      const sourceEnd = frame.worldToLocal(worldEnd);
      const sourceDirection = sourceEnd.sub(sourceOrigin);
      return sourceDirection.lengthSq() > 0.000001 ? vectorTuple(sourceDirection.normalize()) : ([1, 0, 0] as [number, number, number]);
    };

    const helperBoxForTarget = (target: KinematicEditTarget) => {
      const objectNames = [...(target.parentObjectNames ?? []), ...(target.childObjectNames ?? []), ...(target.affectedObjectNames ?? [])];
      const objects = findObjectsByNames(target.nodeId, objectNames);
      const box = new THREE.Box3();
      objects.forEach((object) => box.expandByObject(object));
      if (!objects.length || box.isEmpty()) {
        const nodeObject = findNodeObject(target.nodeId);
        if (nodeObject) box.setFromObject(nodeObject);
      }
      if (box.isEmpty()) box.setFromObject(assetRoot);
      return box;
    };

    const kinematicWorldFrame = (target: KinematicEditTarget) => {
      const box = helperBoxForTarget(target);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      const modelSize = Math.max(size.x, size.y, size.z, 0.0001);
      let origin = sourcePointToWorld(target.nodeId, target.origin);
      if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !Number.isFinite(origin.z) || origin.distanceTo(center) > modelSize * 3) {
        origin = center;
      }
      const axis = sourceDirectionToWorld(target.nodeId, target.axis);
      return {
        origin,
        axis,
        box,
        center,
        modelSize,
        helperLength: clamp(modelSize * 0.42, 0.32, 2.2),
        markerRadius: clamp(modelSize * 0.026, 0.04, 0.12),
      };
    };

    const clearKinematicHelpers = () => {
      kinematicHelperGroup.children.forEach((child) => {
        if ((child as THREE.ArrowHelper).line) {
          const arrow = child as THREE.ArrowHelper;
          arrow.line.geometry.dispose();
          arrow.cone.geometry.dispose();
          disposeHelperMaterial(arrow.line.material);
          disposeHelperMaterial(arrow.cone.material);
      } else if (child instanceof THREE.BoxHelper) {
        const box = child as THREE.BoxHelper;
        box.geometry.dispose();
        disposeHelperMaterial(box.material);
      } else if (child instanceof THREE.Sprite) {
        const sprite = child as THREE.Sprite;
        sprite.material.map?.dispose();
        sprite.material.dispose();
      } else {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
        if (mesh.material) disposeHelperMaterial(mesh.material);
      }
      });
      kinematicHelperGroup.clear();
      kinematicAxisHandle.visible = false;
    };

    const addMarker = (position: THREE.Vector3, color: string, radius = 0.055) => {
      const marker = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      marker.position.copy(position);
      marker.renderOrder = 18;
      kinematicHelperGroup.add(marker);
      return marker;
    };

    const addLabel = (position: THREE.Vector3, text: string, color: string, scale: number) => {
      const canvas = window.document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 48;
      const context = canvas.getContext('2d');
      if (!context) return undefined;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.font = '700 26px Arial';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillStyle = 'rgba(8, 12, 15, 0.72)';
      context.fillRect(18, 8, 60, 32);
      context.strokeStyle = color;
      context.lineWidth = 3;
      context.strokeRect(18, 8, 60, 32);
      context.fillStyle = color;
      context.fillText(text, 48, 25);
      const texture = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
      sprite.position.copy(position);
      sprite.scale.set(scale * 0.62, scale * 0.31, 1);
      sprite.renderOrder = 19;
      kinematicHelperGroup.add(sprite);
      return sprite;
    };

    const addArrow = (origin: THREE.Vector3, direction: THREE.Vector3, color: string | number, length = 0.7) => {
      const safeDirection = direction.lengthSq() > 0.000001 ? direction.clone().normalize() : new THREE.Vector3(1, 0, 0);
      const arrow = new THREE.ArrowHelper(safeDirection, origin, length, color, clamp(length * 0.18, 0.035, 0.16), clamp(length * 0.08, 0.018, 0.08));
      disposeHelperMaterial(arrow.line.material);
      disposeHelperMaterial(arrow.cone.material);
      arrow.line.material = new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false });
      arrow.cone.material = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false });
      arrow.renderOrder = 18;
      arrow.line.renderOrder = 18;
      arrow.cone.renderOrder = 18;
      kinematicHelperGroup.add(arrow);
      return arrow;
    };

    const findObjectsByNames = (nodeId: string, objectNames: string[] | undefined) => {
      if (!objectNames?.length) return [];
      const names = new Set(objectNames);
      const objects: THREE.Object3D[] = [];
      assetRoot.traverse((object) => {
        if (object.userData.nodeId === nodeId && names.has(object.name)) objects.push(object);
      });
      return objects;
    };

    const addObjectHighlights = (nodeId: string, objectNames: string[] | undefined, color: string) => {
      findObjectsByNames(nodeId, objectNames).forEach((object) => {
        const box = new THREE.BoxHelper(object, color);
        box.renderOrder = 17;
        kinematicHelperGroup.add(box);
      });
    };

    const sourceCenterForObject = (nodeId: string, objectName: string | undefined, fallbackObject: THREE.Object3D | undefined) => {
      const objects = objectName ? findObjectsByNames(nodeId, [objectName]) : [];
      const box = new THREE.Box3();
      objects.forEach((object) => box.expandByObject(object));
      if (!objects.length && fallbackObject) box.setFromObject(fallbackObject);
      if (box.isEmpty()) {
        const sourceObject = findSourceObject(nodeId);
        box.setFromObject(sourceObject);
      }
      const center = new THREE.Vector3();
      box.getCenter(center);
      return vectorTuple(sourcePointFromWorld(nodeId, center));
    };

    const syncKinematicHelpers = () => {
      clearKinematicHelpers();
      const target = kinematicEditTargetRef.current;
      if (!target) return;
      const frame = kinematicWorldFrame(target);
      addObjectHighlights(target.nodeId, target.affectedObjectNames, '#7dd3fc');
      addObjectHighlights(target.nodeId, target.parentObjectNames, '#4ea1ff');
      addObjectHighlights(target.nodeId, target.childObjectNames, '#ffd23f');
      addMarker(frame.origin, '#ff4d6d', frame.markerRadius);
      const xAxis = sourceDirectionToWorld(target.nodeId, [1, 0, 0]);
      const yAxis = sourceDirectionToWorld(target.nodeId, [0, 1, 0]);
      const zAxis = sourceDirectionToWorld(target.nodeId, [0, 0, 1]);
      const referenceLength = target.mode === 'show-joint' ? frame.helperLength * 0.72 : frame.helperLength * 0.9;
      addArrow(frame.origin, xAxis, '#ef4444', referenceLength);
      addArrow(frame.origin, yAxis, '#22c55e', referenceLength);
      addArrow(frame.origin, zAxis, '#3b82f6', referenceLength);
      addLabel(frame.origin.clone().add(xAxis.clone().multiplyScalar(referenceLength * 1.18)), 'X', '#ef4444', frame.helperLength);
      addLabel(frame.origin.clone().add(yAxis.clone().multiplyScalar(referenceLength * 1.18)), 'Y', '#22c55e', frame.helperLength);
      addLabel(frame.origin.clone().add(zAxis.clone().multiplyScalar(referenceLength * 1.18)), 'Z', '#3b82f6', frame.helperLength);
      addArrow(frame.origin, frame.axis, '#ffd23f', frame.helperLength);
      addLabel(frame.origin.clone().add(frame.axis.clone().multiplyScalar(frame.helperLength * 1.2)), 'Axis', '#ffd23f', frame.helperLength * 1.24);
      if (target.axisPointA) addMarker(sourcePointToWorld(target.nodeId, target.axisPointA), '#7dd3fc', frame.markerRadius * 0.8);
      if (target.drivenPoint) {
        const drivenWorld = sourcePointToWorld(target.nodeId, target.drivenPoint);
        addMarker(drivenWorld, '#c084fc', frame.markerRadius * 0.9);
        addLabel(drivenWorld.clone().add(new THREE.Vector3(0, frame.helperLength * 0.22, 0)), 'Moving', '#c084fc', frame.helperLength * 1.12);
        addArrow(frame.origin, drivenWorld.clone().sub(frame.origin), '#c084fc', Math.min(frame.origin.distanceTo(drivenWorld), frame.helperLength * 1.3));
      }
      if (target.mode === 'axis-gizmo') {
        kinematicAxisHandle.position.copy(frame.origin.clone().add(frame.axis.clone().multiplyScalar(frame.helperLength * 1.08)));
        kinematicAxisHandle.visible = true;
      }
      if (target.focusKey && target.focusKey !== renderer.domElement.dataset.kinematicFocusKey) {
        renderer.domElement.dataset.kinematicFocusKey = target.focusKey;
        const focusTarget = frame.center.clone().lerp(frame.origin, 0.35);
        const distance = clamp(frame.modelSize * 2.65, 3.4, 14);
        orbit.target.copy(focusTarget);
        camera.position.copy(focusTarget.clone().add(new THREE.Vector3(distance, distance * 0.58, distance)));
        camera.lookAt(focusTarget);
        orbit.update();
      }
    };

    const findFreeDragTarget = (hit: THREE.Object3D | undefined, nodeId: string | undefined) => {
      if (!hit || !nodeId) return undefined;
      const node = documentRef.current.nodes.find((item) => item.id === nodeId);
      if (node?.geometry.kind !== 'imported-model') {
        const nodeObject = findNodeObject(nodeId);
        return nodeObject ? { nodeId, object: nodeObject } : undefined;
      }

      let current: THREE.Object3D | null | undefined = hit;
      while (current && current !== assetRoot) {
        if (current.userData.nodeId === nodeId && current.name && current.name !== node.name) {
          return current.name ? { nodeId, object: current, objectName: current.name } : undefined;
        }
        current = current.parent;
      }

      return undefined;
    };

    const findObjectByPartKey = (key: string) => {
      const [nodeId, objectName] = key.split('::');
      let result: THREE.Object3D | undefined;
      [assetRoot, partTransformGroup].forEach((root) =>
        root.traverse((candidate) => {
        if (!result && candidate.userData.nodeId === nodeId && candidate.name === objectName) {
          result = candidate;
        }
        }),
      );
      return result ? { nodeId, objectName, object: result } : undefined;
    };

    const clearSelectedPartBoxes = () => {
      clearBoxHelpers(scene, selectedPartBoxes);
    };

    const renderSelectedPartBoxes = () => {
      clearSelectedPartBoxes();
      if (captureModeRef.current) return;
      if (toolRef.current !== 'parts') return;

      [...selectedPartKeysRef.current].forEach((key) => {
        const item = findObjectByPartKey(key);
        if (!item) {
          selectedPartKeysRef.current.delete(key);
          return;
        }
        const box = new THREE.BoxHelper(item.object, '#ffd23f');
        selectedPartBoxes.push(box);
        scene.add(box);
      });
    };

    const notifyPartSelectionChange = () => {
      const selection = [...selectedPartKeysRef.current]
        .map((key) => {
          const [nodeId, objectName] = key.split('::');
          return nodeId && objectName ? { nodeId, objectName } : undefined;
        })
        .filter((item): item is ImportedPartSelection => Boolean(item));
      onPartSelectionChangeRef.current(selection);
    };

    const clearPartTransformGroup = () => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      if (transform.object === partTransformGroup) transform.detach();
      runtime.partTransformItems.forEach((item) => {
        if (item.originalParent && item.object.parent === partTransformGroup) {
          item.originalParent.attach(item.object);
        }
      });
      runtime.partTransformItems = [];
      partTransformGroup.clear();
      partTransformGroup.position.set(0, 0, 0);
      partTransformGroup.rotation.set(0, 0, 0);
      partTransformGroup.scale.set(1, 1, 1);
    };

    const syncPartTransformGroup = () => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      clearPartTransformGroup();
      if (toolRef.current !== 'parts' || partEditModeRef.current === 'free' || !selectedPartKeysRef.current.size) return;

      const items = [...selectedPartKeysRef.current]
        .map(findObjectByPartKey)
        .filter((item): item is { nodeId: string; objectName: string; object: THREE.Object3D } => Boolean(item))
        .map((item) => ({ ...item, originalParent: item.object.parent }));
      if (!items.length) return;

      const center = new THREE.Vector3();
      items.forEach((item) => {
        const worldPosition = new THREE.Vector3();
        item.object.getWorldPosition(worldPosition);
        center.add(worldPosition);
      });
      center.divideScalar(items.length);
      partTransformGroup.position.copy(center);
      partTransformGroup.updateMatrixWorld(true);
      items.forEach((item) => partTransformGroup.attach(item.object));
      runtime.partTransformItems = items;
      transform.attach(partTransformGroup);
      transform.setMode(partEditModeRef.current);
    };

    const cursorPlanePoint = (event: PointerEvent, plane: THREE.Plane) => {
      updatePointer(event);
      raycaster.setFromCamera(pointer, camera);
      const point = new THREE.Vector3();
      return raycaster.ray.intersectPlane(plane, point) ? point : undefined;
    };

    const makeObjectDrag = (
      event: PointerEvent,
      primary: { nodeId: string; object: THREE.Object3D; objectName?: string },
      items: Array<{ nodeId: string; object: THREE.Object3D; objectName?: string }>,
    ) => {
      const primaryWorldPosition = new THREE.Vector3();
      primary.object.getWorldPosition(primaryWorldPosition);
      const cameraDirection = new THREE.Vector3();
      camera.getWorldDirection(cameraDirection);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDirection, primaryWorldPosition);
      const cursorPoint = cursorPlanePoint(event, plane) ?? primaryWorldPosition;
      return {
        pointerId: event.pointerId,
        plane,
        startCursorPoint: cursorPoint,
        items: items.map((item) => {
          const startWorldPosition = new THREE.Vector3();
          item.object.getWorldPosition(startWorldPosition);
          return {
            ...item,
            startWorldPosition,
          };
        }),
      };
    };

    const projectWorldToClient = (world: THREE.Vector3) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const projected = world.clone().project(camera);
      return {
        x: rect.left + ((projected.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - projected.y) / 2) * rect.height,
      };
    };

    const jointAxisVector = (axis?: MotionAxis) => {
      if (axis === 'y') return new THREE.Vector3(0, 1, 0);
      if (axis === 'z') return new THREE.Vector3(0, 0, 1);
      return new THREE.Vector3(1, 0, 0);
    };

    const normalizeScreenDelta = (x: number, y: number) => {
      const length = Math.hypot(x, y);
      return length > 0.0001 ? { x: x / length, y: y / length } : { x: 1, y: 0 };
    };

    const shortestAngleDelta = (start: number, currentAngle: number) => {
      let delta = currentAngle - start;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      return delta;
    };

    const cursorControlForJoint = (joint: ImportedJointPose): CursorMotionControl => {
      if (joint.cursorControl) return joint.cursorControl;
      if (joint.motionKind === 'translation') return 'linear-axis';

      const name = joint.name.toLowerCase();
      if (/wheel|tire|tyre/.test(name)) return 'dial-rotation';
      if (/base|yaw|axis_?1|axis 1|rotating/.test(name) || joint.axis === 'y') return 'horizontal-rotation';
      if (/pitch|pith|shoulder|elbow|axis_?[2-4]|axis [2-4]/.test(name) || joint.axis === 'x') return 'vertical-rotation';
      return 'horizontal-rotation';
    };

    const makeJointDrag = (event: PointerEvent, pickedJoint: NonNullable<ReturnType<typeof findPickedJoint>>) => {
      const jointObject = pickedJoint.object ?? assetRoot;
      const pivotWorld = new THREE.Vector3();
      jointObject.getWorldPosition(pivotWorld);
      const pivotClient = projectWorldToClient(pivotWorld);
      const startValue = activeJointValue(pickedJoint.joint);
      const motionKind = pickedJoint.joint.motionKind ?? 'rotation';
      const cursorControl = cursorControlForJoint(pickedJoint.joint);

      if (cursorControl === 'linear-axis') {
        const axisWorld = jointAxisVector(pickedJoint.joint.axis);
        const quaternion = new THREE.Quaternion();
        jointObject.getWorldQuaternion(quaternion);
        axisWorld.applyQuaternion(quaternion).normalize();

        const axisClientEnd = projectWorldToClient(pivotWorld.clone().add(axisWorld));
        const axisClient = normalizeScreenDelta(axisClientEnd.x - pivotClient.x, axisClientEnd.y - pivotClient.y);
        const startAxisDistance = (event.clientX - pivotClient.x) * axisClient.x + (event.clientY - pivotClient.y) * axisClient.y;

        return {
          pointerId: event.pointerId,
          nodeId: pickedJoint.node.id,
          jointName: pickedJoint.joint.name,
          motionKind,
          cursorControl,
          min: pickedJoint.joint.min ?? -0.45,
          max: pickedJoint.joint.max ?? 0.45,
          startX: event.clientX,
          startY: event.clientY,
          startValue,
          pivotClient,
          axisClient,
          startAxisDistance,
        };
      }

      return {
        pointerId: event.pointerId,
        nodeId: pickedJoint.node.id,
        jointName: pickedJoint.joint.name,
        motionKind,
        cursorControl,
        min: pickedJoint.joint.min ?? -3.14,
        max: pickedJoint.joint.max ?? 3.14,
        startX: event.clientX,
        startY: event.clientY,
        startValue,
        pivotClient,
        startAngle: Math.atan2(event.clientY - pivotClient.y, event.clientX - pivotClient.x),
      };
    };

    const clearViewportSelection = () => {
      selectedPartKeysRef.current.clear();
      renderSelectedPartBoxes();
      notifyPartSelectionChange();
      clearPartTransformGroup();
      transform.detach();
      onSelectRef.current(undefined);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (transform.dragging) return;

      updatePointer(event);
      raycaster.setFromCamera(pointer, camera);
      const activeKinematicEdit = kinematicEditTargetRef.current;
      if (activeKinematicEdit?.mode === 'axis-gizmo') {
        const handleHit = kinematicAxisHandle.visible ? raycaster.intersectObject(kinematicAxisHandle, false)[0] : undefined;
        if (handleHit) {
          const frame = kinematicWorldFrame(activeKinematicEdit);
          const cameraDirection = new THREE.Vector3();
          camera.getWorldDirection(cameraDirection);
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDirection, frame.origin);
          axisGizmoDragRef.current = {
            pointerId: event.pointerId,
            plane,
            origin: frame.origin,
            helperLength: frame.helperLength,
            nodeId: activeKinematicEdit.nodeId,
            jointId: activeKinematicEdit.jointId,
          };
          orbit.enabled = false;
          renderer.domElement.setPointerCapture(event.pointerId);
          event.preventDefault();
          return;
        }
      }
      const helperPointerHit = activeKinematicEdit ? raycaster.intersectObjects(kinematicHelperGroup.children, true)[0] : undefined;
      if (
        helperPointerHit &&
        activeKinematicEdit?.mode !== 'pick-origin' &&
        activeKinematicEdit?.mode !== 'pick-driven-point' &&
        activeKinematicEdit?.mode !== 'pick-axis-a' &&
        activeKinematicEdit?.mode !== 'pick-axis-b'
      ) {
        event.preventDefault();
        return;
      }
      const hits = raycaster.intersectObjects([...assetRoot.children, ...partTransformGroup.children], true);
      const firstHit = hits[0];
      const hit = firstHit?.object;
      const nodeId = hit?.userData.nodeId as string | undefined;
      const activeRobotCursorGuideNodeId = robotCursorGuideNodeIdRef.current;
      if (activeRobotCursorGuideNodeId && firstHit?.point) {
        let current: THREE.Object3D | null | undefined = hit;
        let hitBelongsToGuideNode = nodeId === activeRobotCursorGuideNodeId;
        while (!hitBelongsToGuideNode && current && current !== assetRoot) {
          hitBelongsToGuideNode = current.userData.nodeId === activeRobotCursorGuideNodeId;
          current = current.parent;
        }
        if (hitBelongsToGuideNode) {
          const cameraDirection = new THREE.Vector3();
          camera.getWorldDirection(cameraDirection);
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDirection, firstHit.point);
          robotCursorGuideDragRef.current = {
            pointerId: event.pointerId,
            nodeId: activeRobotCursorGuideNodeId,
            plane,
          };
          orbit.enabled = false;
          transform.detach();
          renderer.domElement.setPointerCapture(event.pointerId);
          onSelectRef.current(activeRobotCursorGuideNodeId);
          onRobotCursorGuideRef.current({
            nodeId: activeRobotCursorGuideNodeId,
            point: vectorTuple(sourcePointFromWorld(activeRobotCursorGuideNodeId, firstHit.point)),
            dragging: true,
          });
          event.preventDefault();
          return;
        }
      }
      const freeDragTarget = findFreeDragTarget(hit, nodeId);
      const currentTool = toolRef.current;
      if (
        activeKinematicEdit &&
        firstHit?.point &&
        (activeKinematicEdit.mode === 'pick-origin' ||
          activeKinematicEdit.mode === 'pick-driven-point' ||
          activeKinematicEdit.mode === 'pick-axis-a' ||
          activeKinematicEdit.mode === 'pick-axis-b')
      ) {
        const sourcePoint = vectorTuple(sourcePointFromWorld(activeKinematicEdit.nodeId, firstHit.point));
        const sourceObject = findSourceObject(activeKinematicEdit.nodeId);
        const triangles = hit ? referenceTrianglesForObject(hit, sourceObject).triangles : [];
        onSelectRef.current(activeKinematicEdit.nodeId);
        onKinematicPointPickRef.current({
          nodeId: activeKinematicEdit.nodeId,
          jointId: activeKinematicEdit.jointId,
          mode: activeKinematicEdit.mode,
          point: sourcePoint,
          objectName: hit?.name,
          candidate: activeKinematicEdit.mode === 'pick-origin' ? inferJointFrameFromSeed(triangles, sourcePoint) : undefined,
        });
        event.preventDefault();
        return;
      }
      const pickedJoint = currentTool === 'select' ? findPickedJoint(hit, firstHit?.point) : undefined;

      if (pickedJoint) {
        onSelectRef.current(pickedJoint.node.id);
        transform.detach();
        orbit.enabled = false;
        renderer.domElement.setPointerCapture(event.pointerId);
        jointDragRef.current = {
          ...makeJointDrag(event, pickedJoint),
        };
        event.preventDefault();
        return;
      }

      if (!nodeId) {
        clearViewportSelection();
        event.preventDefault();
        return;
      }

      onSelectRef.current(nodeId);
      if (currentTool === 'parts' && !freeDragTarget) {
        if (selectedPartKeysRef.current.size) {
          selectedPartKeysRef.current.clear();
          renderSelectedPartBoxes();
          notifyPartSelectionChange();
          syncPartTransformGroup();
        }
        event.preventDefault();
        return;
      }

      if (currentTool === 'parts' && freeDragTarget) {
        const clickedKey = freeDragTarget.objectName ? partKey(freeDragTarget.nodeId, freeDragTarget.objectName) : undefined;
        const modifyingSelection = event.ctrlKey || event.metaKey || event.shiftKey;
        if (clickedKey) {
          const selectedKeys = selectedPartKeysRef.current;
          if (modifyingSelection) {
            if (selectedKeys.has(clickedKey)) selectedKeys.delete(clickedKey);
            else selectedKeys.add(clickedKey);
          } else if (!selectedKeys.has(clickedKey)) {
            selectedKeys.clear();
            selectedKeys.add(clickedKey);
          }
          renderSelectedPartBoxes();
          notifyPartSelectionChange();
        }

        if (modifyingSelection) {
          syncPartTransformGroup();
          event.preventDefault();
          return;
        }

        if (partEditModeRef.current !== 'free') {
          syncPartTransformGroup();
          event.preventDefault();
          return;
        }

        clearPartTransformGroup();
        const selectedItems = [...selectedPartKeysRef.current]
          .map(findObjectByPartKey)
          .filter((item): item is { nodeId: string; objectName: string; object: THREE.Object3D } => Boolean(item));
        const dragItems =
          freeDragTarget.objectName && selectedItems.some((item) => item.nodeId === freeDragTarget.nodeId && item.objectName === freeDragTarget.objectName)
            ? selectedItems
            : [freeDragTarget];

        transform.detach();
        orbit.enabled = false;
        renderer.domElement.setPointerCapture(event.pointerId);
        dragItems.forEach((item) => {
          item.object.userData.freeDragging = true;
        });
        objectDragRef.current = makeObjectDrag(event, freeDragTarget, dragItems);
        renderSelectedPartBoxes();
        event.preventDefault();
      }
    };

    const onDoubleClick = (event: MouseEvent) => {
      updatePointer(event as PointerEvent);
      raycaster.setFromCamera(pointer, camera);
      const firstHit = raycaster.intersectObjects([...assetRoot.children, ...partTransformGroup.children], true)[0];
      if (firstHit) {
        const hit = firstHit.object;
        const nodeId = hit.userData.nodeId as string | undefined;
        if (nodeId) {
          const kinematicContext = findKinematicContext(hit);
          const objectName = kinematicContext?.objectName ?? hit.name;
          onNodeDoubleClickRef.current?.({
            nodeId,
            x: event.clientX,
            y: event.clientY,
            objectName,
            jointId: kinematicContext?.jointId,
            jointIds: kinematicContext?.jointIds,
            point: vectorTuple(sourcePointFromWorld(nodeId, firstHit.point)),
            objectCenter: sourceCenterForObject(nodeId, objectName, hit),
          });
          event.preventDefault();
        }
        return;
      }
      clearViewportSelection();
      event.preventDefault();
    };

    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      updatePointer(event as PointerEvent);
      raycaster.setFromCamera(pointer, camera);
      const firstHit = raycaster.intersectObjects([...kinematicHelperGroup.children, ...assetRoot.children], true)[0];
      const hit = firstHit?.object;
      const activeTarget = kinematicEditTargetRef.current;
      const helperHit = Boolean(hit && kinematicHelperGroup.children.some((child) => child === hit || child.children.includes(hit)));
      const nodeId = (helperHit ? activeTarget?.nodeId : hit?.userData.nodeId) as string | undefined;
      if (!nodeId) return;
      const kinematicContext = findKinematicContext(hit);
      const objectName = kinematicContext?.objectName ?? hit?.name;
      onSelectRef.current(nodeId);
      onNodeContextMenuRef.current?.({
        nodeId,
        x: event.clientX,
        y: event.clientY,
        objectName,
        jointId: helperHit ? activeTarget?.jointId : kinematicContext?.jointId,
        jointIds: helperHit && activeTarget?.jointId ? [activeTarget.jointId] : kinematicContext?.jointIds,
        point: firstHit?.point ? vectorTuple(sourcePointFromWorld(nodeId, firstHit.point)) : undefined,
        objectCenter: sourceCenterForObject(nodeId, objectName, hit),
      });
    };

    const onPointerMove = (event: PointerEvent) => {
      const activeAxisGizmoDrag = axisGizmoDragRef.current;
      if (activeAxisGizmoDrag && activeAxisGizmoDrag.pointerId === event.pointerId) {
        const cursorPoint = cursorPlanePoint(event, activeAxisGizmoDrag.plane);
        if (cursorPoint) {
          const axis = cursorPoint.clone().sub(activeAxisGizmoDrag.origin);
          if (axis.lengthSq() > 0.000001) {
            const worldAxis = axis.clone().normalize();
            const normalized = worldDirectionToSource(activeAxisGizmoDrag.nodeId, worldAxis);
            kinematicAxisHandle.position.copy(activeAxisGizmoDrag.origin.clone().add(worldAxis.multiplyScalar(activeAxisGizmoDrag.helperLength * 1.08)));
            onKinematicAxisChangeRef.current({
              nodeId: activeAxisGizmoDrag.nodeId,
              jointId: activeAxisGizmoDrag.jointId,
              axis: normalized,
            });
          }
        }
        event.preventDefault();
        return;
      }

      const activeRobotCursorGuideDrag = robotCursorGuideDragRef.current;
      if (activeRobotCursorGuideDrag && activeRobotCursorGuideDrag.pointerId === event.pointerId) {
        const cursorPoint = cursorPlanePoint(event, activeRobotCursorGuideDrag.plane);
        if (cursorPoint) {
          onRobotCursorGuideRef.current({
            nodeId: activeRobotCursorGuideDrag.nodeId,
            point: vectorTuple(sourcePointFromWorld(activeRobotCursorGuideDrag.nodeId, cursorPoint)),
            dragging: true,
          });
        }
        event.preventDefault();
        return;
      }

      const activeDrag = jointDragRef.current;
      const activeObjectDrag = objectDragRef.current;
      if (activeObjectDrag && activeObjectDrag.pointerId === event.pointerId) {
        const cursorPoint = cursorPlanePoint(event, activeObjectDrag.plane);
        if (cursorPoint) {
          const delta = cursorPoint.clone().sub(activeObjectDrag.startCursorPoint);
          activeObjectDrag.items.forEach((item) => {
            const nextWorldPosition = item.startWorldPosition.clone().add(delta);
            const nextLocalPosition = item.object.parent ? item.object.parent.worldToLocal(nextWorldPosition.clone()) : nextWorldPosition;
            item.object.position.copy(nextLocalPosition);
            item.object.updateMatrixWorld(true);
          });
          selectionBox.setFromObject(activeObjectDrag.items[0].object);
          selectionBox.visible = true;
          selectedPartBoxes.forEach((box) => box.update());
        }
        event.preventDefault();
        return;
      }

      if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;

      let delta = 0;
      if (activeDrag.cursorControl === 'linear-axis' && activeDrag.axisClient && activeDrag.startAxisDistance !== undefined) {
        const currentAxisDistance =
          (event.clientX - activeDrag.pivotClient.x) * activeDrag.axisClient.x + (event.clientY - activeDrag.pivotClient.y) * activeDrag.axisClient.y;
        delta = (currentAxisDistance - activeDrag.startAxisDistance) * 0.006;
      } else if (activeDrag.cursorControl === 'horizontal-rotation') {
        delta = (event.clientX - activeDrag.startX) * 0.008;
      } else if (activeDrag.cursorControl === 'vertical-rotation') {
        delta = -(event.clientY - activeDrag.startY) * 0.008;
      } else if (activeDrag.cursorControl === 'dial-rotation' && activeDrag.startAngle !== undefined) {
        const currentAngle = Math.atan2(event.clientY - activeDrag.pivotClient.y, event.clientX - activeDrag.pivotClient.x);
        delta = shortestAngleDelta(activeDrag.startAngle, currentAngle);
      }

      const nextValue = clamp(activeDrag.startValue + delta, activeDrag.min, activeDrag.max);
      onJointPoseChangeRef.current(activeDrag.nodeId, activeDrag.jointName, nextValue);
      event.preventDefault();
    };

    const finishJointDrag = (event: PointerEvent) => {
      const activeRobotCursorGuideDrag = robotCursorGuideDragRef.current;
      if (activeRobotCursorGuideDrag && activeRobotCursorGuideDrag.pointerId === event.pointerId) {
        const cursorPoint = cursorPlanePoint(event, activeRobotCursorGuideDrag.plane);
        if (cursorPoint) {
          onRobotCursorGuideRef.current({
            nodeId: activeRobotCursorGuideDrag.nodeId,
            point: vectorTuple(sourcePointFromWorld(activeRobotCursorGuideDrag.nodeId, cursorPoint)),
            dragging: false,
          });
        }
        robotCursorGuideDragRef.current = undefined;
        orbit.enabled = true;
        if (renderer.domElement.hasPointerCapture(event.pointerId)) {
          renderer.domElement.releasePointerCapture(event.pointerId);
        }
        event.preventDefault();
        return;
      }

      const activeAxisGizmoDrag = axisGizmoDragRef.current;
      if (activeAxisGizmoDrag && activeAxisGizmoDrag.pointerId === event.pointerId) {
        axisGizmoDragRef.current = undefined;
        orbit.enabled = true;
        if (renderer.domElement.hasPointerCapture(event.pointerId)) {
          renderer.domElement.releasePointerCapture(event.pointerId);
        }
        event.preventDefault();
        return;
      }

      const activeObjectDrag = objectDragRef.current;
      if (activeObjectDrag && activeObjectDrag.pointerId === event.pointerId) {
        activeObjectDrag.items.forEach((item) => {
          item.object.userData.freeDragging = false;
        });
        objectDragRef.current = undefined;
        orbit.enabled = true;
        if (renderer.domElement.hasPointerCapture(event.pointerId)) {
          renderer.domElement.releasePointerCapture(event.pointerId);
        }
        const partUpdates = activeObjectDrag.items
          .filter((item) => item.objectName)
          .map((item) => ({
            nodeId: item.nodeId,
            objectName: item.objectName!,
            transform: toTransform(item.object),
          }));
        if (partUpdates.length) {
          onImportedPartTransformsCommitRef.current(partUpdates);
        }

        const nodeUpdate = activeObjectDrag.items.find((item) => !item.objectName);
        if (nodeUpdate) {
          onTransformCommitRef.current(nodeUpdate.nodeId, toTransform(nodeUpdate.object));
        }
        renderSelectedPartBoxes();
        syncPartTransformGroup();
        event.preventDefault();
        return;
      }

      const activeDrag = jointDragRef.current;
      if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;

      jointDragRef.current = undefined;
      orbit.enabled = true;
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('dblclick', onDoubleClick);
    renderer.domElement.addEventListener('contextmenu', onContextMenu);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', finishJointDrag);
    renderer.domElement.addEventListener('pointercancel', finishJointDrag);
    window.addEventListener('pointerup', finishJointDrag);
    window.addEventListener('pointercancel', finishJointDrag);

    const resize = () => {
      renderer.setSize(host.clientWidth, host.clientHeight);
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);

    const animate = (time: number) => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      const frameDelta = Math.max(1, time - runtime.lastFrameTime);
      runtime.lastFrameTime = time;
      const renderStart = performance.now();
      runtime.frames += 1;
      if (time - runtime.lastFrame > 500) {
        runtime.fps = Math.round((runtime.frames * 1000) / (time - runtime.lastFrame));
        runtime.frames = 0;
        runtime.lastFrame = time;
      }

      orbit.update();
      applyKinematicGraphState(assetRoot, documentRef.current);
      applyRuntimeMotionDemo(assetRoot, documentRef.current, motionDemoNodeIdRef.current, motionTrainingPreviewRef.current, time / 1000);
      if (industrialCellDemoActiveRef.current) applyIndustrialCellCycleDemo(assetRoot, documentRef.current, time / 1000);
      syncKinematicHelpers();
      if (selectionBox.visible) selectionBox.update();
      selectedPartBoxes.forEach((box) => box.update());
      renderer.render(scene, camera);
      const renderDuration = performance.now() - renderStart;
      runtime.cpuPercent = Math.round(Math.min(100, renderDuration / frameDelta) * 100);
      if (time - runtime.lastStatsUpdate > 1000) {
        runtime.lastStatsUpdate = time;
        const nextStats = {
          fps: runtime.fps,
          objects: documentRef.current.nodes.length,
          triangles: countTriangles(assetRoot),
          cpuPercent: runtime.cpuPercent,
          ...readBrowserMemory(),
        };
        setLiveStats(nextStats);
        onStatsChangeRef.current(nextStats);
      }
      runtime.animationId = requestAnimationFrame(animate);
    };

    runtimeRef.current = {
      renderer,
      camera,
      scene,
      raycaster,
      pointer,
      orbit,
      transform,
      assetRoot,
      selectionBox,
      selectedPartBoxes,
      partTransformGroup,
      kinematicHelperGroup,
      kinematicAxisHandle,
      partTransformItems: [],
      animationId: requestAnimationFrame(animate),
      lastFrame: performance.now(),
      lastFrameTime: performance.now(),
      lastStatsUpdate: performance.now(),
      frames: 0,
      fps: 0,
      cpuPercent: 0,
    };

    const runtimeWindow = window as Window & {
      __assetForgeViewportPickPoints?: () => Array<{ x: number; y: number; name: string }>;
      __assetForgeViewportPickActiveKinematicPoint?: () => boolean;
      __assetForgeViewportActiveJointPoint?: () => { x: number; y: number } | undefined;
      __assetForgeViewportKinematicDebug?: () =>
        | {
            axisLength: number;
            modelSize: number;
            axisRatio: number;
            distanceFromModelCenter: number;
            finite: boolean;
            point: { x: number; y: number };
            canvas: { width: number; height: number };
          }
        | undefined;
      __assetForgeViewportSetCamera?: (view: { position: [number, number, number]; target: [number, number, number] }) => boolean;
      __assetForgeViewportPrepareCapture?: () => boolean;
      __assetForgeViewportFrameModel?: () => boolean;
      __assetForgeViewportMechanicsDebug?: () => {
        objects: Array<{ name: string; nodeId?: string; position: [number, number, number]; parent?: string; pivot?: boolean }>;
      };
      __assetForgeViewportIndustrialCellDebug?: () =>
        | {
            cargoA1?: { position: [number, number, number]; picked: boolean; touched: boolean; released: boolean };
            looseCargo?: Array<{ name: string; position: [number, number, number]; picked: boolean; touched: boolean; released: boolean }>;
            grip?: { position: [number, number, number] };
            cargoGripDistance?: number;
            carriedCargoName?: string;
          }
        | undefined;
      __assetForgeViewportPlaceCargoA1AtGrip?: () => boolean;
      __assetForgeViewportPlaceLooseCargoAtGrip?: () => boolean;
      __assetForgeSelectFirstTwoViewportParts?: () => boolean;
      __assetForgeSelectedViewportPartPoint?: () => { x: number; y: number } | undefined;
      __assetForgeMoveSelectedViewportParts?: () => boolean;
    };
    runtimeWindow.__assetForgeViewportPickPoints = () => {
      const rect = renderer.domElement.getBoundingClientRect();
      const points: Array<{ x: number; y: number; name: string }> = [];
      assetRoot.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.geometry || !object.visible) return;
        const world = new THREE.Vector3();
        object.getWorldPosition(world);
        const projected = world.project(camera);
        if (projected.z < -1 || projected.z > 1) return;
        const x = ((projected.x + 1) / 2) * rect.width;
        const y = ((1 - projected.y) / 2) * rect.height;
        if (x >= 0 && x <= rect.width && y >= 0 && y <= rect.height) {
          points.push({ x, y, name: object.name });
        }
      });
      return points;
    };
    runtimeWindow.__assetForgeViewportPickActiveKinematicPoint = () => {
      const target = kinematicEditTargetRef.current;
      if (!target || (target.mode !== 'pick-origin' && target.mode !== 'pick-driven-point' && target.mode !== 'pick-axis-a' && target.mode !== 'pick-axis-b')) return false;
      let picked: THREE.Object3D | undefined;
      assetRoot.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (picked || !mesh.geometry || !object.visible) return;
        if (target.mode === 'pick-axis-b' && target.axisPointA) {
          const world = new THREE.Vector3();
          object.getWorldPosition(world);
          const sourcePoint = sourcePointFromWorld(target.nodeId, world);
          const distance = sourcePoint.distanceTo(new THREE.Vector3(...target.axisPointA));
          if (distance < 0.05) return;
        }
        picked = object;
      });
      if (!picked && target.mode === 'pick-axis-b' && target.axisPointA) {
        onSelectRef.current(target.nodeId);
        onKinematicPointPickRef.current({
          nodeId: target.nodeId,
          jointId: target.jointId,
          mode: target.mode,
          point: [target.axisPointA[0] + 0.5, target.axisPointA[1], target.axisPointA[2]],
          objectName: 'axis-fallback',
        });
        return true;
      }
      if (!picked) return false;
      const world = new THREE.Vector3();
      picked.getWorldPosition(world);
      const sourceObject = findSourceObject(target.nodeId);
      const sourcePoint = vectorTuple(sourcePointFromWorld(target.nodeId, world));
      const triangles = referenceTrianglesForObject(picked, sourceObject).triangles;
      onSelectRef.current(target.nodeId);
      onKinematicPointPickRef.current({
        nodeId: target.nodeId,
        jointId: target.jointId,
        mode: target.mode,
        point: sourcePoint,
        objectName: picked.name,
        candidate: target.mode === 'pick-origin' ? inferJointFrameFromSeed(triangles, sourcePoint) : undefined,
      });
      return true;
    };
    runtimeWindow.__assetForgeViewportActiveJointPoint = () => {
      const target = kinematicEditTargetRef.current;
      if (!target) return undefined;
      const rect = renderer.domElement.getBoundingClientRect();
      const frame = kinematicWorldFrame(target);
      const projected = frame.origin.clone().project(camera);
      return {
        x: ((projected.x + 1) / 2) * rect.width,
        y: ((1 - projected.y) / 2) * rect.height,
      };
    };
    runtimeWindow.__assetForgeViewportKinematicDebug = () => {
      const target = kinematicEditTargetRef.current;
      if (!target) return undefined;
      const rect = renderer.domElement.getBoundingClientRect();
      const frame = kinematicWorldFrame(target);
      const projected = frame.origin.clone().project(camera);
      const point = {
        x: ((projected.x + 1) / 2) * rect.width,
        y: ((1 - projected.y) / 2) * rect.height,
      };
      return {
        axisLength: frame.helperLength,
        modelSize: frame.modelSize,
        axisRatio: frame.helperLength / frame.modelSize,
        distanceFromModelCenter: frame.origin.distanceTo(frame.center),
        finite:
          Number.isFinite(frame.origin.x) &&
          Number.isFinite(frame.origin.y) &&
          Number.isFinite(frame.origin.z) &&
          Number.isFinite(frame.helperLength) &&
          Number.isFinite(frame.modelSize),
        point,
        canvas: { width: rect.width, height: rect.height },
      };
    };
    runtimeWindow.__assetForgeViewportSetCamera = (view) => {
      if (!Array.isArray(view.position) || !Array.isArray(view.target)) return false;
      camera.position.set(view.position[0], view.position[1], view.position[2]);
      orbit.target.set(view.target[0], view.target[1], view.target[2]);
      camera.lookAt(orbit.target);
      camera.updateProjectionMatrix();
      orbit.update();
      return true;
    };
    runtimeWindow.__assetForgeViewportPrepareCapture = () => {
      captureModeRef.current = true;
      transform.detach();
      transform.enabled = false;
      transform.getHelper().visible = false;
      selectionBox.visible = false;
      clearSelectedPartBoxes();
      kinematicHelperGroup.visible = false;
      kinematicAxisHandle.visible = false;
      return true;
    };
    runtimeWindow.__assetForgeViewportFrameModel = () => {
      const box = new THREE.Box3().setFromObject(assetRoot);
      if (box.isEmpty()) return false;
      const center = new THREE.Vector3();
      const size = new THREE.Vector3();
      box.getCenter(center);
      box.getSize(size);
      const verticalFov = THREE.MathUtils.degToRad(camera.fov);
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(camera.aspect, 0.1));
      const fitHeight = size.y / (2 * Math.tan(verticalFov / 2));
      const fitWidth = Math.max(size.x, size.z) / (2 * Math.tan(horizontalFov / 2));
      const distance = Math.max(fitHeight, fitWidth, size.length() * 0.36, 0.8) * 1.86;
      const viewDirection = new THREE.Vector3(1, 0.5, -0.92).normalize();
      camera.position.copy(center).add(viewDirection.multiplyScalar(distance));
      orbit.target.copy(center);
      camera.lookAt(orbit.target);
      camera.updateProjectionMatrix();
      orbit.update();
      return true;
    };
    runtimeWindow.__assetForgeViewportMechanicsDebug = () => {
      const objects: Array<{ name: string; nodeId?: string; position: [number, number, number]; parent?: string; pivot?: boolean; materialColor?: string }> = [];
      const interesting = /(__static_rig_pivot_|J[1-6]_|G1_finger|finger_|gripper|tool_flange|wrist|turret|shoulder|upper_arm|forearm|base_|plate|bolt|cap|ring|j[1-6]_(shell|seal|drum|cap|ring)|belt_motion_mark|P\d+_part|part_box|part_tape|R[12]_|Robot|Arm_|ARM__|BASE__|HEAD__|GRIP|Chwytak|Z_o_e|TooBig|__-_BASE_N)/i;
      assetRoot.updateMatrixWorld(true);
      assetRoot.traverse((object) => {
        if (!object.name || !interesting.test(object.name)) return;
        const position = new THREE.Vector3();
        const mesh = object as THREE.Mesh;
        const materialWithColor = mesh.isMesh
          ? (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material & { color?: THREE.Color }
          : undefined;
        if (mesh.isMesh && mesh.geometry) {
          const box = new THREE.Box3().setFromObject(mesh);
          if (!box.isEmpty()) box.getCenter(position);
          else object.getWorldPosition(position);
        } else {
          object.getWorldPosition(position);
        }
        objects.push({
          name: object.name,
          nodeId: object.userData.nodeId as string | undefined,
          position: [position.x, position.y, position.z],
          parent: object.parent?.name,
          pivot: Boolean(object.userData.staticRigPivot),
          materialColor: materialWithColor?.color ? `#${materialWithColor.color.getHexString()}` : undefined,
        });
      });
      return { objects };
    };
    runtimeWindow.__assetForgeViewportIndustrialCellDebug = () => {
      assetRoot.updateMatrixWorld(true);
      const looseCargo = documentRef.current.nodes
        .filter((node) => isLooseIndustrialCargoBox(node))
        .map((node) => {
          const object = assetRoot.children.find((child) => child.userData.nodeId === node.id);
          if (!object) return undefined;
          const position = new THREE.Vector3();
          object.getWorldPosition(position);
          return {
            name: node.name,
            position: [position.x, position.y, position.z] as [number, number, number],
            picked: Boolean(object.userData.industrialCellPicked),
            touched: Boolean(object.userData.industrialCellTouched),
            released: Boolean(object.userData.industrialCellReleased),
          };
        })
        .filter((item): item is { name: string; position: [number, number, number]; picked: boolean; touched: boolean; released: boolean } => Boolean(item));
      const cargoNode = documentRef.current.nodes.find((node) => /Cargo Box A1|Loose Box 1/i.test(node.name));
      const cargo = cargoNode ? assetRoot.children.find((child) => child.userData.nodeId === cargoNode.id) : undefined;
      const grip = findIndustrialGantryGrip(assetRoot);
      if (!cargo && !grip && !looseCargo.length) return undefined;
      const cargoWorld = new THREE.Vector3();
      const gripWorld = grip?.worldPosition.clone();
      cargo?.getWorldPosition(cargoWorld);
      const carriedNodeId = assetRoot.userData.industrialCellCarriedCargoNodeId as string | undefined;
      const carriedCargoName = documentRef.current.nodes.find((node) => node.id === carriedNodeId)?.name;
      return {
        cargoA1: cargo
          ? {
              position: [cargoWorld.x, cargoWorld.y, cargoWorld.z] as [number, number, number],
              picked: Boolean(cargo.userData.industrialCellPicked),
              touched: Boolean(cargo.userData.industrialCellTouched),
              released: Boolean(cargo.userData.industrialCellReleased),
            }
          : undefined,
        looseCargo,
        grip: gripWorld ? { position: [gripWorld.x, gripWorld.y, gripWorld.z] as [number, number, number] } : undefined,
        cargoGripDistance: cargo && gripWorld ? cargoWorld.distanceTo(gripWorld) : undefined,
        carriedCargoName,
      };
    };
    runtimeWindow.__assetForgeViewportPlaceCargoA1AtGrip = () => {
      const cargoNode = documentRef.current.nodes.find((node) => /Cargo Box A1|Loose Box 1/i.test(node.name));
      const cargo = cargoNode ? assetRoot.children.find((child) => child.userData.nodeId === cargoNode.id) : undefined;
      const grip = findIndustrialGantryGrip(assetRoot);
      if (!cargo || !grip) return false;
      const local = localPointFromWorld(assetRoot, grip.worldPosition.clone().add(new THREE.Vector3(0, -0.24, 0)));
      cargo.position.copy(local);
      cargo.userData.industrialCellRestPosition = local.clone();
      if (!cargo.userData.industrialCellPicked && !cargo.userData.industrialCellTouched && !cargo.userData.industrialCellReleased) {
        cargo.userData.industrialCellPicked = false;
        cargo.userData.industrialCellTouched = false;
        cargo.userData.industrialCellReleased = false;
      }
      cargo.userData.industrialCellGripOffset = [0, -0.24, 0];
      cargo.updateMatrixWorld(true);
      return true;
    };
    runtimeWindow.__assetForgeViewportPlaceLooseCargoAtGrip = runtimeWindow.__assetForgeViewportPlaceCargoA1AtGrip;
    runtimeWindow.__assetForgeSelectFirstTwoViewportParts = () => {
      const items: Array<{ nodeId: string; objectName: string }> = [];
      assetRoot.traverse((object) => {
        const mesh = object as THREE.Mesh;
        const nodeId = object.userData.nodeId as string | undefined;
        if (!mesh.geometry || !nodeId || !object.name) return;
        if (!items.some((item) => item.nodeId === nodeId && item.objectName === object.name)) {
          items.push({ nodeId, objectName: object.name });
        }
      });
      const selected = items.slice(0, 2);
      if (selected.length < 2) return false;
      onSelectRef.current(selected[0].nodeId);
      selectedPartKeysRef.current.clear();
      selected.forEach((item) => selectedPartKeysRef.current.add(partKey(item.nodeId, item.objectName)));
      renderSelectedPartBoxes();
      notifyPartSelectionChange();
      syncPartTransformGroup();
      return true;
    };
    runtimeWindow.__assetForgeSelectedViewportPartPoint = () => {
      const key = [...selectedPartKeysRef.current][0];
      if (!key) return undefined;
      const item = findObjectByPartKey(key);
      if (!item) return undefined;
      const rect = renderer.domElement.getBoundingClientRect();
      const world = new THREE.Vector3();
      item.object.getWorldPosition(world);
      const projected = world.project(camera);
      return {
        x: ((projected.x + 1) / 2) * rect.width,
        y: ((1 - projected.y) / 2) * rect.height,
      };
    };
    runtimeWindow.__assetForgeMoveSelectedViewportParts = () => {
      const items = [...selectedPartKeysRef.current]
        .map(findObjectByPartKey)
        .filter((item): item is { nodeId: string; objectName: string; object: THREE.Object3D } => Boolean(item));
      if (!items.length) return false;
      const updates = items.map((item) => {
        item.object.position.x += 0.18;
        item.object.updateMatrixWorld(true);
        return {
          nodeId: item.nodeId,
          objectName: item.objectName,
          transform: toTransform(item.object),
        };
      });
      renderSelectedPartBoxes();
      onImportedPartTransformsCommitRef.current(updates);
      return true;
    };

    return () => {
      delete runtimeWindow.__assetForgeViewportPickPoints;
      delete runtimeWindow.__assetForgeViewportPickActiveKinematicPoint;
      delete runtimeWindow.__assetForgeViewportActiveJointPoint;
      delete runtimeWindow.__assetForgeViewportKinematicDebug;
      delete runtimeWindow.__assetForgeViewportSetCamera;
      delete runtimeWindow.__assetForgeViewportPrepareCapture;
      delete runtimeWindow.__assetForgeViewportFrameModel;
      delete runtimeWindow.__assetForgeViewportMechanicsDebug;
      delete runtimeWindow.__assetForgeViewportIndustrialCellDebug;
      delete runtimeWindow.__assetForgeViewportPlaceCargoA1AtGrip;
      delete runtimeWindow.__assetForgeViewportPlaceLooseCargoAtGrip;
      delete runtimeWindow.__assetForgeSelectFirstTwoViewportParts;
      delete runtimeWindow.__assetForgeSelectedViewportPartPoint;
      delete runtimeWindow.__assetForgeMoveSelectedViewportParts;
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('dblclick', onDoubleClick);
      renderer.domElement.removeEventListener('contextmenu', onContextMenu);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', finishJointDrag);
      renderer.domElement.removeEventListener('pointercancel', finishJointDrag);
      window.removeEventListener('pointerup', finishJointDrag);
      window.removeEventListener('pointercancel', finishJointDrag);
      clearPartTransformGroup();
      clearSelectedPartBoxes();
      clearKinematicHelpers();
      kinematicAxisHandle.geometry.dispose();
      disposeHelperMaterial(kinematicAxisHandle.material);
      cancelAnimationFrame(runtimeRef.current?.animationId ?? 0);
      transform.dispose();
      orbit.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    let disposed = false;
    const nextSignature = renderStructureSignature(document);
    const renderRuntimeSelectedPartBoxes = () => {
      clearBoxHelpers(runtime.scene, runtime.selectedPartBoxes);
      if (tool !== 'parts') return;

      [...selectedPartKeysRef.current].forEach((key) => {
        const [nodeId, objectName] = key.split('::');
        let object: THREE.Object3D | undefined;
        [runtime.assetRoot, runtime.partTransformGroup].forEach((root) =>
          root.traverse((candidate) => {
            if (!object && candidate.userData.nodeId === nodeId && candidate.name === objectName) {
              object = candidate;
            }
          }),
        );
        if (!object) {
          selectedPartKeysRef.current.delete(key);
          return;
        }
        const box = new THREE.BoxHelper(object, '#ffd23f');
        runtime.selectedPartBoxes.push(box);
        runtime.scene.add(box);
      });
    };

    const clearRuntimePartTransformGroup = () => {
      runtime.transform.detach();
      runtime.partTransformItems.forEach((item) => {
        if (item.originalParent && item.object.parent === runtime.partTransformGroup) {
          item.originalParent.attach(item.object);
        }
      });
      runtime.partTransformItems = [];
      runtime.partTransformGroup.clear();
      runtime.partTransformGroup.position.set(0, 0, 0);
      runtime.partTransformGroup.rotation.set(0, 0, 0);
      runtime.partTransformGroup.scale.set(1, 1, 1);
    };

    const syncRuntimePartTransformGroup = () => {
      clearRuntimePartTransformGroup();
      if (tool !== 'parts' || partEditMode === 'free' || !selectedPartKeysRef.current.size) return;

      const items = [...selectedPartKeysRef.current]
        .map((key) => {
          const [nodeId, objectName] = key.split('::');
          let object: THREE.Object3D | undefined;
          [runtime.assetRoot, runtime.partTransformGroup].forEach((root) =>
            root.traverse((candidate) => {
              if (!object && candidate.userData.nodeId === nodeId && candidate.name === objectName) {
                object = candidate;
              }
            }),
          );
          return object && objectName ? { nodeId, objectName, object, originalParent: object.parent } : undefined;
        })
        .filter((item): item is { nodeId: string; objectName: string; object: THREE.Object3D; originalParent: THREE.Object3D | null } => Boolean(item));

      if (!items.length) return;

      const center = new THREE.Vector3();
      items.forEach((item) => {
        const worldPosition = new THREE.Vector3();
        item.object.getWorldPosition(worldPosition);
        center.add(worldPosition);
      });
      center.divideScalar(items.length);
      runtime.partTransformGroup.position.copy(center);
      runtime.partTransformGroup.updateMatrixWorld(true);
      items.forEach((item) => runtime.partTransformGroup.attach(item.object));
      runtime.partTransformItems = items;
      runtime.transform.attach(runtime.partTransformGroup);
      runtime.transform.setMode(partEditMode);
    };

    const syncViewportControls = () => {
      const selected = runtime.assetRoot.children.find((child) => child.userData.nodeId === document.selectedNodeId);
      runtime.transform.detach();

      if (captureModeRef.current) {
        runtime.transform.enabled = false;
        runtime.transform.getHelper().visible = false;
        runtime.selectionBox.visible = false;
        selectedPartKeysRef.current.clear();
        clearBoxHelpers(runtime.scene, runtime.selectedPartBoxes);
        clearRuntimePartTransformGroup();
        return;
      }

      runtime.transform.enabled = true;
      runtime.transform.getHelper().visible = true;

      const selectedNode = document.nodes.find((node) => node.id === document.selectedNodeId);
      if (tool !== 'parts') {
        const hadSelectedParts = selectedPartKeysRef.current.size > 0;
        selectedPartKeysRef.current.clear();
        clearBoxHelpers(runtime.scene, runtime.selectedPartBoxes);
        clearRuntimePartTransformGroup();
        if (hadSelectedParts) onPartSelectionChangeRef.current([]);
      } else if (!runtime.selectedPartBoxes.length && selectedPartKeysRef.current.size) {
        renderRuntimeSelectedPartBoxes();
      }

      if (selected && tool !== 'select' && tool !== 'parts' && !selectedNode?.locked) {
        runtime.transform.attach(selected);
        runtime.transform.setMode(tool);
      } else if (tool === 'parts') {
        syncRuntimePartTransformGroup();
      }

      runtime.transform.setTranslationSnap(snapEnabled ? 0.25 : null);
      runtime.transform.setRotationSnap(snapEnabled ? Math.PI / 12 : null);
      runtime.transform.setScaleSnap(snapEnabled ? 0.1 : null);

      if (selected) {
        runtime.selectionBox.setFromObject(selected);
        runtime.selectionBox.visible = true;
      } else {
        runtime.selectionBox.visible = false;
      }
    };

    if (renderStructureSignatureRef.current === nextSignature) {
      applyDocumentJointPoses(runtime.assetRoot, document);
      applyKinematicGraphState(runtime.assetRoot, document);
      syncViewportControls();
      if (runtime.selectionBox.visible) runtime.selectionBox.update();
      const nextStats = {
        fps: runtime.fps,
        objects: document.nodes.length,
        triangles: countTriangles(runtime.assetRoot),
        cpuPercent: runtime.cpuPercent,
        ...readBrowserMemory(),
      };
      setLiveStats(nextStats);
      onStatsChangeRef.current(nextStats);
      return () => {
        disposed = true;
      };
    }

    createRenderableSceneAsync(document.nodes).then((renderable) => {
      if (disposed) return;
      renderStructureSignatureRef.current = nextSignature;
      clearRuntimePartTransformGroup();
      clearBoxHelpers(runtime.scene, runtime.selectedPartBoxes);
      runtime.assetRoot.clear();
      runtime.assetRoot.add(...renderable.children);
      runtime.assetRoot.traverse((child) => {
        delete child.userData.kinematicRestAssetMatrix;
      });
      runtime.assetRoot.updateMatrixWorld(true);
      document.nodes.forEach((node) => {
        if (
          node.geometry.kind !== 'imported-model' ||
          !node.geometry.isIsolatedFunctionalComponent ||
          node.geometry.pieceReferenceCenter ||
          estimatedReferenceNodeIdsRef.current.has(node.id)
        ) {
          return;
        }
        const nodeObject = runtime.assetRoot.children.find((child) => child.userData.nodeId === node.id);
        const sourceObject = nodeObject?.children[0] ?? nodeObject;
        if (!nodeObject || !sourceObject) return;
        const { triangles, boundsCenter } = referenceTrianglesForObject(nodeObject, sourceObject);
        const estimate = estimatePieceReferenceCenter(triangles, boundsCenter);
        const analysis = analyzeGeometryCached(triangles);
        estimatedReferenceNodeIdsRef.current.add(node.id);
        onPieceReferenceCenterEstimateRef.current({
          nodeId: node.id,
          position: estimate.position,
          method: estimate.method,
          confidence: estimate.confidence,
          triangleCount: estimate.triangleCount,
          geometricProperties: analysis.geometricProperties,
          massProperties: analysis.massProperties,
        });
      });
      renderRuntimeSelectedPartBoxes();
      syncViewportControls();

      const nextStats = {
        fps: runtime.fps,
        objects: document.nodes.length,
        triangles: countTriangles(runtime.assetRoot),
        cpuPercent: runtime.cpuPercent,
        ...readBrowserMemory(),
      };
      setLiveStats(nextStats);
      onStatsChangeRef.current(nextStats);
    });

    return () => {
      disposed = true;
    };
  }, [document, tool, snapEnabled, partEditMode, kinematicEditTarget]);

  const memoryLabel =
    liveStats.memoryUsedMb !== undefined
      ? `${liveStats.memoryPercent ?? 0}% / ${liveStats.memoryUsedMb} MB${liveStats.memoryTotalMb ? ` / ${liveStats.memoryTotalMb} MB` : ''}`
      : 'n/a';

  return (
    <div className="viewport" ref={hostRef}>
      {viewportNotice && (
        <div className="viewport-guidance-toast" aria-live="polite">
          {viewportNotice}
        </div>
      )}
      <div className="viewport-resource-meter" aria-label="Live resource monitor">
        <span>CPU {liveStats.cpuPercent}%</span>
        <span>RAM {memoryLabel}</span>
        <span>{liveStats.fps} FPS</span>
      </div>
    </div>
  );
};
