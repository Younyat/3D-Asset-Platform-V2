import type {
  KinematicAnimationSettings,
  KinematicGraph,
  KinematicJoint,
  KinematicMotionClip,
  KinematicMotionKeyframe,
  KinematicRigControl,
  KinematicState,
  MechanicalPart,
} from '../../domain/kinematics';

export type RigHierarchyNode = {
  part: MechanicalPart;
  depth: number;
  incomingJoint?: KinematicJoint;
  children: RigHierarchyNode[];
};

export type RigDiagnostic = {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  jointId?: string;
  partId?: string;
};

const DEFAULT_SETTINGS: KinematicAnimationSettings = {
  fps: 24,
  autoKey: false,
  interpolation: 'smooth',
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, lower: number, upper: number) => Math.min(upper, Math.max(lower, value));
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'item';
const uniqueId = (prefix: string, name: string, existingIds: Iterable<string>) => {
  const existing = new Set(existingIds);
  const base = `${prefix}_${slug(name)}`;
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
};

export const normalizeAnimationSettings = (settings?: Partial<KinematicAnimationSettings>): KinematicAnimationSettings => ({
  fps: clamp(finite(settings?.fps) ? settings.fps : DEFAULT_SETTINGS.fps, 1, 240),
  autoKey: Boolean(settings?.autoKey),
  interpolation: settings?.interpolation === 'linear' || settings?.interpolation === 'step' ? settings.interpolation : 'smooth',
  activeClipId: settings?.activeClipId,
});

export const buildRigHierarchy = (graph: KinematicGraph): RigHierarchyNode[] => {
  const partById = new Map(graph.parts.map((part) => [part.id, part]));
  const incomingByChild = new Map<string, KinematicJoint>();
  const childrenByParent = new Map<string, KinematicJoint[]>();
  graph.joints
    .filter((joint) => joint.status !== 'rejected')
    .forEach((joint) => {
      if (!incomingByChild.has(joint.childPartId)) incomingByChild.set(joint.childPartId, joint);
      childrenByParent.set(joint.parentPartId, [...(childrenByParent.get(joint.parentPartId) ?? []), joint]);
    });

  const visited = new Set<string>();
  const walk = (partId: string, depth: number): RigHierarchyNode | undefined => {
    const part = partById.get(partId);
    if (!part || visited.has(partId)) return undefined;
    visited.add(partId);
    const children = (childrenByParent.get(partId) ?? [])
      .map((joint) => walk(joint.childPartId, depth + 1))
      .filter((node): node is RigHierarchyNode => Boolean(node));
    return { part, depth, incomingJoint: incomingByChild.get(partId), children };
  };

  const roots = [graph.rootPartId, ...graph.parts.filter((part) => !incomingByChild.has(part.id)).map((part) => part.id)];
  const hierarchy = roots.map((partId) => walk(partId, 0)).filter((node): node is RigHierarchyNode => Boolean(node));
  graph.parts.forEach((part) => {
    const orphan = walk(part.id, 0);
    if (orphan) hierarchy.push(orphan);
  });
  return hierarchy;
};

export const flattenRigHierarchy = (nodes: RigHierarchyNode[]): RigHierarchyNode[] =>
  nodes.flatMap((node) => [node, ...flattenRigHierarchy(node.children)]);

export const diagnoseAdvancedRig = (graph: KinematicGraph): RigDiagnostic[] => {
  const diagnostics: RigDiagnostic[] = [];
  const partIds = new Set(graph.parts.map((part) => part.id));
  const jointIds = new Set(graph.joints.map((joint) => joint.id));
  const childOwners = new Map<string, string>();

  graph.joints.forEach((joint) => {
    if (!partIds.has(joint.parentPartId)) diagnostics.push({ severity: 'error', code: 'MISSING_PARENT', message: `${joint.name} has no valid parent part.`, jointId: joint.id });
    if (!partIds.has(joint.childPartId)) diagnostics.push({ severity: 'error', code: 'MISSING_CHILD', message: `${joint.name} has no valid child part.`, jointId: joint.id });
    if (joint.parentPartId === joint.childPartId) diagnostics.push({ severity: 'error', code: 'SELF_PARENT', message: `${joint.name} connects a part to itself.`, jointId: joint.id });
    const previous = childOwners.get(joint.childPartId);
    if (previous && joint.status !== 'rejected') diagnostics.push({ severity: 'error', code: 'MULTIPLE_PARENTS', message: `${joint.childPartId} is driven by multiple joints.`, jointId: joint.id });
    if (joint.status !== 'rejected') childOwners.set(joint.childPartId, joint.id);
    if (joint.type !== 'continuous' && finite(joint.limits?.lower) && finite(joint.limits?.upper) && joint.limits.lower > joint.limits.upper) {
      diagnostics.push({ severity: 'error', code: 'INVERTED_LIMITS', message: `${joint.name} has inverted limits.`, jointId: joint.id });
    }
    const axisLength = Math.hypot(...joint.axis);
    if (joint.type !== 'fixed' && (!finite(axisLength) || axisLength < 0.999 || axisLength > 1.001)) {
      diagnostics.push({ severity: 'warning', code: 'AXIS_NOT_NORMALIZED', message: `${joint.name} axis should be normalized.`, jointId: joint.id });
    }
    if (joint.coupling && !jointIds.has(joint.coupling.driverJointId)) {
      diagnostics.push({ severity: 'error', code: 'MISSING_DRIVER', message: `${joint.name} references a missing coupling driver.`, jointId: joint.id });
    }
  });

  graph.rigControls?.forEach((control) => {
    if (!jointIds.has(control.jointId)) diagnostics.push({ severity: 'warning', code: 'ORPHAN_CONTROL', message: `${control.name} references a missing joint.` });
  });
  graph.motionClips?.forEach((clip) => {
    let previousTime = -Infinity;
    clip.keyframes.forEach((keyframe) => {
      if (keyframe.time < previousTime) diagnostics.push({ severity: 'warning', code: 'UNSORTED_KEYS', message: `${clip.name} keyframes are not sorted.` });
      previousTime = keyframe.time;
      Object.keys(keyframe.jointValues).forEach((jointId) => {
        if (!jointIds.has(jointId)) diagnostics.push({ severity: 'warning', code: 'ORPHAN_CURVE', message: `${clip.name} animates missing joint ${jointId}.` });
      });
    });
  });
  if (!diagnostics.length) diagnostics.push({ severity: 'info', code: 'RIG_VALID', message: 'Hierarchy, controls, constraints and animation channels are consistent.' });
  return diagnostics;
};

const controlShapeForJoint = (joint: KinematicJoint): KinematicRigControl['shape'] => {
  if (joint.type === 'prismatic') return 'slider';
  if (joint.type === 'fixed') return 'sphere';
  return 'ring';
};

const controlColorForJoint = (joint: KinematicJoint) => {
  if (joint.type === 'prismatic') return '#55d6ca';
  if (joint.type === 'fixed') return '#8e9aa2';
  return '#e8661f';
};

export const ensureRigControls = (graph: KinematicGraph): KinematicGraph => {
  const existing = new Map((graph.rigControls ?? []).map((control) => [control.jointId, control]));
  const ids = new Set((graph.rigControls ?? []).map((control) => control.id));
  const rigControls = graph.joints
    .filter((joint) => joint.status !== 'rejected')
    .map((joint) => {
      const current = existing.get(joint.id);
      if (current) return current;
      const id = uniqueId('control', joint.name, ids);
      ids.add(id);
      return {
        id,
        name: `${joint.name} Control`,
        jointId: joint.id,
        shape: controlShapeForJoint(joint),
        color: controlColorForJoint(joint),
        size: 1,
        visible: true,
      } satisfies KinematicRigControl;
    });
  return { ...graph, rigControls, animationSettings: normalizeAnimationSettings(graph.animationSettings) };
};

export const updateRigControl = (graph: KinematicGraph, controlId: string, patch: Partial<KinematicRigControl>): KinematicGraph => ({
  ...graph,
  rigControls: (graph.rigControls ?? []).map((control) =>
    control.id === controlId
      ? {
          ...control,
          ...patch,
          size: patch.size === undefined ? control.size : clamp(patch.size, 0.1, 10),
        }
      : control,
  ),
});

export const updateAnimationSettings = (graph: KinematicGraph, patch: Partial<KinematicAnimationSettings>): KinematicGraph => ({
  ...graph,
  animationSettings: normalizeAnimationSettings({ ...graph.animationSettings, ...patch }),
});

export const createMotionClip = (graph: KinematicGraph, name = 'Robot Action', duration = 4): { graph: KinematicGraph; clip: KinematicMotionClip } => {
  const clip: KinematicMotionClip = {
    id: uniqueId('clip', name, (graph.motionClips ?? []).map((item) => item.id)),
    name,
    duration: clamp(duration, 0.1, 3600),
    loop: false,
    source: 'manual',
    description: 'Advanced rig action authored from KinematicGraph poses.',
    keyframes: [],
  };
  return {
    graph: {
      ...graph,
      motionClips: [...(graph.motionClips ?? []), clip],
      animationSettings: { ...normalizeAnimationSettings(graph.animationSettings), activeClipId: clip.id },
    },
    clip,
  };
};

export const setActiveMotionClip = (graph: KinematicGraph, clipId?: string): KinematicGraph => ({
  ...graph,
  animationSettings: { ...normalizeAnimationSettings(graph.animationSettings), activeClipId: clipId },
});

export const activeMotionClip = (graph: KinematicGraph): KinematicMotionClip | undefined => {
  const settings = normalizeAnimationSettings(graph.animationSettings);
  return graph.motionClips?.find((clip) => clip.id === settings.activeClipId) ?? graph.motionClips?.[0];
};

export const upsertPoseKeyframe = (
  graph: KinematicGraph,
  clipId: string,
  time: number,
  state: KinematicState,
  options: { label?: string; selectedJointId?: string; tolerance?: number } = {},
): KinematicGraph => {
  const settings = normalizeAnimationSettings(graph.animationSettings);
  const tolerance = options.tolerance ?? 1 / settings.fps / 2;
  return {
    ...graph,
    motionClips: (graph.motionClips ?? []).map((clip) => {
      if (clip.id !== clipId) return clip;
      const safeTime = clamp(time, 0, clip.duration);
      const values = options.selectedJointId
        ? { [options.selectedJointId]: state.jointValues[options.selectedJointId] ?? state.homeJointValues[options.selectedJointId] ?? 0 }
        : { ...state.jointValues };
      const existingIndex = clip.keyframes.findIndex((keyframe) => Math.abs(keyframe.time - safeTime) <= tolerance);
      const keyframe: KinematicMotionKeyframe = {
        time: safeTime,
        label: options.label,
        interpolation: settings.interpolation,
        jointValues: existingIndex >= 0 ? { ...clip.keyframes[existingIndex].jointValues, ...values } : values,
      };
      const keyframes = existingIndex >= 0
        ? clip.keyframes.map((item, index) => (index === existingIndex ? keyframe : item))
        : [...clip.keyframes, keyframe];
      return { ...clip, keyframes: keyframes.sort((a, b) => a.time - b.time) };
    }),
  };
};

export const deleteMotionKeyframe = (graph: KinematicGraph, clipId: string, keyframeIndex: number): KinematicGraph => ({
  ...graph,
  motionClips: (graph.motionClips ?? []).map((clip) =>
    clip.id === clipId ? { ...clip, keyframes: clip.keyframes.filter((_, index) => index !== keyframeIndex) } : clip,
  ),
});

export const moveMotionKeyframe = (graph: KinematicGraph, clipId: string, keyframeIndex: number, nextTime: number): KinematicGraph => ({
  ...graph,
  motionClips: (graph.motionClips ?? []).map((clip) => {
    if (clip.id !== clipId) return clip;
    const keyframes = clip.keyframes.map((keyframe, index) =>
      index === keyframeIndex ? { ...keyframe, time: clamp(nextTime, 0, clip.duration) } : keyframe,
    );
    return { ...clip, keyframes: keyframes.sort((a, b) => a.time - b.time) };
  }),
});

export const updateMotionClip = (graph: KinematicGraph, clipId: string, patch: Partial<Pick<KinematicMotionClip, 'name' | 'duration' | 'loop' | 'description'>>): KinematicGraph => ({
  ...graph,
  motionClips: (graph.motionClips ?? []).map((clip) =>
    clip.id === clipId
      ? {
          ...clip,
          ...patch,
          duration: patch.duration === undefined ? clip.duration : clamp(patch.duration, 0.1, 3600),
          keyframes: clip.keyframes.map((keyframe) => ({ ...keyframe, time: clamp(keyframe.time, 0, patch.duration ?? clip.duration) })),
        }
      : clip,
  ),
});

export const deleteMotionClip = (graph: KinematicGraph, clipId: string): KinematicGraph => {
  const motionClips = (graph.motionClips ?? []).filter((clip) => clip.id !== clipId);
  const settings = normalizeAnimationSettings(graph.animationSettings);
  return {
    ...graph,
    motionClips,
    animationSettings: { ...settings, activeClipId: settings.activeClipId === clipId ? motionClips[0]?.id : settings.activeClipId },
  };
};

export const frameToSeconds = (frame: number, fps: number) => Math.max(0, frame) / normalizeAnimationSettings({ fps }).fps;
export const secondsToFrame = (seconds: number, fps: number) => Math.round(Math.max(0, seconds) * normalizeAnimationSettings({ fps }).fps);

