import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const port = Number(process.env.CELL_RIG_TEST_PORT ?? 5231);
const viteBin = resolve('node_modules', 'vite', 'bin', 'vite.js');

const models = [
  {
    name: 'Cobot 6DOF GLB',
    path: resolve('3d imported models', 'celda_robotica', 'cobot-6dof.glb'),
    expectedAsset: 'cobot-6dof.glb',
    analysisVersion: 'professional-rig-1.1',
    jointNames: ['J1_base_rotate', 'J2_shoulder_lift', 'J3_elbow', 'J4_wrist_1', 'J5_wrist_2', 'J6_wrist_3'],
    clipNames: ['Ciclo_Asistencia', 'Guiado_Manual', 'Demo_Ejes'],
    axes: {
      J1_base_rotate: 'Y',
      J2_shoulder_lift: 'Z',
      J3_elbow: 'Z',
      J4_wrist_1: 'Z',
      J5_wrist_2: 'X',
      J6_wrist_3: 'Y',
    },
    expectedClipPoses: [
      { clip: 'Ciclo_Asistencia', time: 1.4, valuesDeg: { J1: -55, J2: -10, J3: 85, J4: 25, J5: 0, J6: 0 } },
      { clip: 'Ciclo_Asistencia', time: 7.6, valuesDeg: { J1: 50, J2: 15, J3: 80, J4: -5, J5: 30, J6: -90 } },
      { clip: 'Demo_Ejes', time: 1.6, valuesDeg: { J1: -175 } },
      { clip: 'Demo_Ejes', time: 4, valuesDeg: { J1: 175 } },
      { clip: 'Demo_Ejes', time: 14.4, valuesDeg: { J6: 270 } },
    ],
  },
  {
    name: 'Cobot 6DOF OBJ',
    path: resolve('3d imported models', 'celda_robotica', 'cobot-6dof.obj'),
    expectedAsset: 'cobot-6dof.obj',
    analysisVersion: 'professional-rig-1.1-cobot-static-obj',
    jointNames: ['J1_base_rotate', 'J2_shoulder_lift', 'J3_elbow', 'J4_wrist_1', 'J5_wrist_2', 'J6_wrist_3'],
    clipNames: ['Ciclo_Asistencia', 'Demo_Ejes'],
    axes: {
      J1_base_rotate: 'Y',
      J2_shoulder_lift: 'Z',
      J3_elbow: 'Z',
      J4_wrist_1: 'Z',
      J5_wrist_2: 'X',
      J6_wrist_3: 'Y',
    },
    staticPivotReferences: {
      J1_base_rotate: 'j1_shell',
      J2_shoulder_lift: 'j2_drum_body',
      J3_elbow: 'j3_drum_body',
      J4_wrist_1: 'j4_drum_body',
      J5_wrist_2: 'j5_drum_body',
      J6_wrist_3: 'wrist_3_shell',
    },
    expectedClipPoses: [
      { clip: 'Ciclo_Asistencia', time: 1.4, valuesDeg: { J1: -55, J2: -10, J3: 85, J4: 25, J5: 0, J6: 0 } },
      { clip: 'Ciclo_Asistencia', time: 7.6, valuesDeg: { J1: 50, J2: 15, J3: 80, J4: -5, J5: 30, J6: -90 } },
      { clip: 'Demo_Ejes', time: 1.6, valuesDeg: { J1: -175 } },
      { clip: 'Demo_Ejes', time: 4, valuesDeg: { J1: 175 } },
      { clip: 'Demo_Ejes', time: 14.4, valuesDeg: { J6: 270 } },
    ],
  },
  {
    name: 'Industrial Arm 6DOF OBJ',
    path: resolve('3d imported models', 'celda_robotica', 'industrial-arm-6dof.obj'),
    expectedAsset: 'industrial-arm-6dof.obj',
    analysisVersion: 'professional-rig-1.1-industrial-static-obj',
    jointNames: ['J1_base_yaw', 'J2_shoulder_pitch', 'J3_elbow_pitch', 'J4_forearm_roll', 'J5_wrist_pitch', 'J6_tool_roll', 'G1_finger_L', 'G1_finger_R'],
    clipNames: ['Toma_De_Cinta', 'Demo_Ejes'],
    axes: {
      J1_base_yaw: 'Y',
      J2_shoulder_pitch: 'Z',
      J3_elbow_pitch: 'Z',
      J4_forearm_roll: 'Y',
      J5_wrist_pitch: 'Z',
      J6_tool_roll: 'Y',
      G1_finger_L: 'X',
      G1_finger_R: 'X',
    },
    staticPivotReferences: {
      J1_base_yaw: 'turret_body',
      J2_shoulder_pitch: 'j2_cap',
      J3_elbow_pitch: 'j3_cap',
      J4_forearm_roll: 'j4_ring',
      J5_wrist_pitch: 'wrist_yoke',
      J6_tool_roll: 'tool_flange',
      G1_finger_L: 'finger_carriage_L',
      G1_finger_R: 'finger_carriage_R',
    },
    expectedClipPoses: [
      { clip: 'Toma_De_Cinta', time: 2.3, valuesDeg: { J1: 0, J2: 32, J3: 72, J4: 0, J5: 16, J6: 0 } },
      { clip: 'Toma_De_Cinta', time: 5.6, valuesDeg: { J1: 95, J2: 10, J3: 75, J4: 90, J5: 35, J6: 0 } },
      { clip: 'Demo_Ejes', time: 14.8, valuesDeg: { J6: 360 } },
    ],
  },
  {
    name: 'Conveyor 2400 GLB',
    path: resolve('3d imported models', 'celda_robotica', 'conveyor-belt-2400.glb'),
    expectedAsset: 'conveyor-belt-2400.glb',
    analysisVersion: 'conveyor-rig-1',
    jointNames: ['R1_drive_roller', 'R2_idler_roller', 'S1_stopper'],
    clipNames: ['Ciclo_Transporte'],
    axes: {
      R1_drive_roller: 'Z',
      R2_idler_roller: 'Z',
      S1_stopper: 'Y',
    },
  },
];

const waitForServer = async (url, timeoutMs = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const countVisiblePixels = async (page) =>
  page.locator('canvas').evaluate((canvas) => {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) || canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return 0;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let visiblePixels = 0;
    for (let y = 0; y < canvas.height; y += 8) {
      for (let x = 0; x < canvas.width; x += 8) {
        const index = (y * canvas.width + x) * 4;
        const diff = Math.abs(pixels[index] - 32) + Math.abs(pixels[index + 1] - 35) + Math.abs(pixels[index + 2] - 38);
        if (diff > 45) visiblePixels += 1;
      }
    }
    return visiblePixels;
  });

const canvasSample = async (page) =>
  page.locator('canvas').evaluate((canvas) => {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) || canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return '';
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const sample = [];
    for (let index = 0; index < pixels.length; index += 96) sample.push(pixels[index], pixels[index + 1], pixels[index + 2]);
    return sample.join(',');
  });

const changedSamples = (a, b) => {
  const left = a.split(',').map(Number);
  const right = b.split(',').map(Number);
  let changed = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 3) {
    const diff = Math.abs(left[index] - right[index]) + Math.abs(left[index + 1] - right[index + 1]) + Math.abs(left[index + 2] - right[index + 2]);
    if (diff > 24) changed += 1;
  }
  return changed;
};

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const debugObject = (debug, pattern) => debug.objects.find((object) => pattern.test(object.name));

const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 56);

const verifyStaticRigPivotPlacement = async (page, model) => {
  if (!model.staticPivotReferences) return;
  const debug = await page.evaluate(() => window.__assetForgeViewportMechanicsDebug?.());
  if (!debug?.objects?.length) throw new Error(`${model.name} did not expose static rig debug objects.`);
  for (const [jointName, referenceName] of Object.entries(model.staticPivotReferences)) {
    const pivotSlug = `joint_${slug(jointName)}`;
    const pivot = debug.objects.find((object) => object.pivot && object.name.toLowerCase().includes(pivotSlug));
    const reference = debug.objects.find((object) => object.name === referenceName);
    if (!pivot || !reference) throw new Error(`${model.name} could not inspect pivot ${jointName} against ${referenceName}.`);
    const gap = distance(pivot.position, reference.position);
    if (gap > 0.055) {
      throw new Error(`${model.name} pivot ${jointName} is ${gap.toFixed(3)}m from ${referenceName}; expected a real joint-frame pivot.`);
    }
  }
};

const pivotForJoint = (debug, jointName) => {
  const pivotSlug = `joint_${slug(jointName)}`;
  return debug.objects.find((object) => object.pivot && object.name.toLowerCase().includes(pivotSlug));
};

const verifyStaticRigChainStability = async (page, model) => {
  if (!model.staticPivotReferences) return;
  const setup = await page.evaluate((expectedAssetName) => {
    const node = window.__assetForgeDocument?.nodes.find((item) => item.geometry?.assetName === expectedAssetName);
    const graph = node?.geometry?.kinematicGraph;
    const clip = graph?.motionClips?.find((candidate) => /ciclo|toma/i.test(candidate.name)) ?? graph?.motionClips?.[0];
    if (!node || !graph || !clip) return undefined;
    const partById = new Map(graph.parts.map((part) => [part.id, part]));
    const jointByChildPartId = new Map(graph.joints.map((joint) => [joint.childPartId, joint]));
    const links = graph.joints
      .map((joint) => {
        const parentJoint = jointByChildPartId.get(joint.parentPartId);
        const parentPart = partById.get(joint.parentPartId);
        if (joint.type === 'prismatic') return undefined;
        if (!parentJoint || parentPart?.static) return undefined;
        return { parent: parentJoint.name, child: joint.name };
      })
      .filter(Boolean);
    return { nodeId: node.id, keyframes: clip.keyframes, links };
  }, model.expectedAsset);
  if (!setup?.links?.length) return;

  await page.evaluate(({ nodeId, values }) => window.__assetForgeSetKinematicJointValues?.(nodeId, values), {
    nodeId: setup.nodeId,
    values: setup.keyframes[0]?.jointValues ?? {},
  });
  await page.waitForTimeout(80);
  const baselineDebug = await page.evaluate(() => window.__assetForgeViewportMechanicsDebug?.());
  const baseline = new Map();
  setup.links.forEach((link) => {
    const parent = pivotForJoint(baselineDebug, link.parent);
    const child = pivotForJoint(baselineDebug, link.child);
    if (parent && child) baseline.set(`${link.parent}->${link.child}`, distance(parent.position, child.position));
  });

  for (let index = 1; index < setup.keyframes.length; index += 1) {
    await page.evaluate(({ nodeId, values }) => window.__assetForgeSetKinematicJointValues?.(nodeId, values), {
      nodeId: setup.nodeId,
      values: setup.keyframes[index]?.jointValues ?? {},
    });
    await page.waitForTimeout(80);
    const debug = await page.evaluate(() => window.__assetForgeViewportMechanicsDebug?.());
    for (const link of setup.links) {
      const key = `${link.parent}->${link.child}`;
      const reference = baseline.get(key);
      const parent = pivotForJoint(debug, link.parent);
      const child = pivotForJoint(debug, link.child);
      if (!parent || !child || !Number.isFinite(reference)) throw new Error(`${model.name} missing pivot chain ${key} at keyframe ${index}.`);
      const current = distance(parent.position, child.position);
      if (Math.abs(current - reference) > 0.006) {
        throw new Error(`${model.name} pivot chain ${key} stretched from ${reference.toFixed(3)}m to ${current.toFixed(3)}m at keyframe ${index}.`);
      }
    }
  }
};

const verifyAutoButtonMotion = async (page, model) => {
  if (!/Conveyor/i.test(model.name)) return;
  await page.waitForFunction(() => window.__assetForgeViewportSetCamera?.({ position: [2.6, 1.35, 1.65], target: [0, 0.78, 0] }), undefined, { timeout: 30000 });
  await page.evaluate((expectedAssetName) => {
    const node = window.__assetForgeDocument?.nodes.find((item) => item.geometry?.assetName === expectedAssetName);
    const home = node?.geometry?.kinematicState?.homeJointValues;
    if (node && home) window.__assetForgeSetKinematicJointValues?.(node.id, home);
  }, model.expectedAsset);
  await page.waitForTimeout(500);
  const mechanicsBefore = await page.evaluate(() => window.__assetForgeViewportMechanicsDebug?.());
  const before = await canvasSample(page);
  await page.getByRole('button', { name: 'Auto cinta' }).click();
  await page.waitForTimeout(1800);
  const after = await canvasSample(page);
  const mechanicsAfter = await page.evaluate(() => window.__assetForgeViewportMechanicsDebug?.());
  const changed = changedSamples(before, after);
  const markerBefore = debugObject(mechanicsBefore, /belt_motion_mark_1/i);
  const markerAfter = debugObject(mechanicsAfter, /belt_motion_mark_1/i);
  const partBefore = debugObject(mechanicsBefore, /P1_part|part_box_1/i);
  const partAfter = debugObject(mechanicsAfter, /P1_part|part_box_1/i);
  const markerMoved = markerBefore && markerAfter ? distance(markerBefore.position, markerAfter.position) : 0;
  const partMoved = partBefore && partAfter ? distance(partBefore.position, partAfter.position) : 0;
  if (markerMoved < 0.18 && partMoved < 0.18) {
    throw new Error(`${model.name} Auto cinta did not move belt geometry; marker ${markerMoved.toFixed(3)}m, part ${partMoved.toFixed(3)}m, changed samples ${changed}`);
  }
  if (changed < 1) throw new Error(`${model.name} Auto cinta did not visibly animate the viewport; changed samples ${changed}`);
};

const verifyEndEffectorIntegrity = async (page, model) => {
  if (!/Industrial Arm/i.test(model.name)) return;
  const keyframeCount = await page.evaluate((expectedAssetName) => {
    const node = window.__assetForgeDocument?.nodes.find((item) => item.geometry?.assetName === expectedAssetName);
    const graph = node?.geometry?.kinematicGraph;
    const clip = graph?.motionClips?.find((candidate) => candidate.name === 'Toma_De_Cinta') ?? graph?.motionClips?.[0];
    return clip?.keyframes.length ?? 0;
  }, model.expectedAsset);

  for (let index = 0; index < keyframeCount; index += 1) {
    const applied = await page.evaluate(
      ({ expectedAssetName, index }) => {
        const node = window.__assetForgeDocument?.nodes.find((item) => item.geometry?.assetName === expectedAssetName);
        const graph = node?.geometry?.kinematicGraph;
        const clip = graph?.motionClips?.find((candidate) => candidate.name === 'Toma_De_Cinta') ?? graph?.motionClips?.[0];
        const keyframe = clip?.keyframes[index];
        if (!node || !keyframe) return false;
        return window.__assetForgeSetKinematicJointValues?.(node.id, keyframe.jointValues) ?? false;
      },
      { expectedAssetName: model.expectedAsset, index },
    );
    if (!applied) throw new Error(`${model.name} could not apply keyframe ${index} for end-effector integrity.`);
    await page.waitForTimeout(80);
    const debug = await page.evaluate(() => window.__assetForgeViewportMechanicsDebug?.());
    const housing = debugObject(debug, /gripper_housing/i);
    const left = debugObject(debug, /finger_carriage_L|finger_jaw_L|finger_tip_L/i);
    const right = debugObject(debug, /finger_carriage_R|finger_jaw_R|finger_tip_R/i);
    const flange = debugObject(debug, /tool_flange/i);
    if (!housing || !left || !right || !flange) throw new Error(`${model.name} missing end-effector debug objects at keyframe ${index}.`);
    const leftDistance = distance(housing.position, left.position);
    const rightDistance = distance(housing.position, right.position);
    const flangeDistance = distance(flange.position, housing.position);
    if (leftDistance > 0.32 || rightDistance > 0.32 || flangeDistance > 0.28) {
      throw new Error(
        `${model.name} end effector decomposed at keyframe ${index}; left ${leftDistance.toFixed(3)}m, right ${rightDistance.toFixed(3)}m, flange ${flangeDistance.toFixed(3)}m.`,
      );
    }
  }
};

const verifyIndustrialMaterialEditing = async (page, model) => {
  if (!/Industrial Arm/i.test(model.name)) return;
  const globalColor = '#00bcd4';
  await page.locator('input[type="color"]').first().fill(globalColor);
  await page.waitForFunction(
    ({ expectedAssetName, globalColor }) => {
      const node = window.__assetForgeDocument?.nodes.find((item) => item.geometry?.assetName === expectedAssetName);
      return node?.material?.color?.toLowerCase() === globalColor;
    },
    { expectedAssetName: model.expectedAsset, globalColor },
    { timeout: 30000 },
  );
  await page.waitForTimeout(700);
  const globalDebug = await page.evaluate(() => window.__assetForgeViewportMechanicsDebug?.());
  const globalColored = globalDebug?.objects?.filter((object) => object.materialColor?.toLowerCase() === globalColor).length ?? 0;
  if (globalColored < 3) throw new Error(`${model.name} did not apply the custom global material color to imported rig meshes.`);

  const selected = await page.evaluate(() => window.__assetForgeSelectFirstTwoKinematicParts?.() ?? false);
  if (!selected) throw new Error(`${model.name} could not select viewport parts for material editing.`);
  await page.waitForFunction(() => (window.__assetForgeSelectedParts?.length ?? 0) > 0, undefined, { timeout: 30000 });
  const partColor = '#ff4fd8';
  await page.locator('input[type="color"]').nth(1).fill(partColor);
  await page.waitForFunction(
    ({ expectedAssetName, partColor }) => {
      const node = window.__assetForgeDocument?.nodes.find((item) => item.geometry?.assetName === expectedAssetName);
      return (node?.geometry?.partMaterials ?? []).some((item) => item.color?.toLowerCase() === partColor);
    },
    { expectedAssetName: model.expectedAsset, partColor },
    { timeout: 30000 },
  );
  await page.waitForTimeout(700);
  const partDebug = await page.evaluate(() => window.__assetForgeViewportMechanicsDebug?.());
  const partColored = partDebug?.objects?.filter((object) => object.materialColor?.toLowerCase() === partColor).length ?? 0;
  if (partColored < 1) throw new Error(`${model.name} did not apply the custom part material color to the selected mesh.`);
};

const verifyMotionChanges = async (page, model) =>
  page.evaluate((expectedAssetName) => {
    const node = window.__assetForgeDocument?.nodes.find((item) => item.geometry?.assetName === expectedAssetName);
    const graph = node?.geometry?.kinematicGraph;
    const state = node?.geometry?.kinematicState;
    const clip = graph?.motionClips?.find((candidate) => /ciclo|toma|transporte/i.test(candidate.name)) ?? graph?.motionClips?.[0];
    if (!node || !graph || !state || !clip?.keyframes?.length) return { changed: 0, error: 'missing graph, state, or clip' };
    const first = clip.keyframes[0]?.jointValues ?? {};
    const target =
      clip.keyframes
        .slice(1)
        .map((keyframe) => ({
          jointValues: keyframe.jointValues ?? {},
          changed: Object.entries(keyframe.jointValues ?? {}).filter(([jointId, value]) => Math.abs(value - (state.homeJointValues[jointId] ?? 0)) > 1e-5).length,
        }))
        .sort((a, b) => b.changed - a.changed)[0]?.jointValues ?? first;
    const values = {};
    graph.joints.forEach((joint) => {
      const nextValue = target[joint.id] ?? first[joint.id] ?? state.homeJointValues[joint.id] ?? 0;
      values[joint.id] = nextValue;
    });
    window.__assetForgeSetKinematicJointValues?.(node.id, values);
    const changed = Object.entries(values).filter(([jointId, value]) => Math.abs(value - (state.homeJointValues[jointId] ?? 0)) > 1e-5).length;
    return { changed, clipName: clip.name };
  }, model.expectedAsset);

const verifyDocumentedClipPoses = async (page, model) => {
  if (!model.expectedClipPoses?.length) return;
  const result = await page.evaluate(
    ({ expectedAssetName, expectedClipPoses }) => {
      const node = window.__assetForgeDocument?.nodes.find((item) => item.geometry?.assetName === expectedAssetName);
      const graph = node?.geometry?.kinematicGraph;
      if (!graph) return { error: 'missing graph', failures: [] };
      const joints = graph.joints.map((joint) => ({
        id: joint.id,
        order: joint.evidence?.[0]?.metadata?.order,
        restValue: joint.evidence?.[0]?.metadata?.restValue ?? 0,
        type: joint.type,
      }));
      const failures = [];
      for (const expected of expectedClipPoses) {
        const clip = graph.motionClips?.find((candidate) => candidate.name === expected.clip);
        if (!clip) {
          failures.push(`${expected.clip}: missing clip`);
          continue;
        }
        const keyframe = clip.keyframes.find((candidate) => Math.abs(candidate.time - expected.time) < 0.0001);
        if (!keyframe) {
          failures.push(`${expected.clip} at ${expected.time}s: missing keyframe`);
          continue;
        }
        Object.entries(expected.valuesDeg).forEach(([order, expectedDeg]) => {
          const joint = joints.find((candidate) => candidate.order === order);
          if (!joint) {
            failures.push(`${expected.clip} ${order}: missing joint`);
            return;
          }
          const absolute = joint.restValue + (keyframe.jointValues[joint.id] ?? 0);
          const actualDeg = absolute * 180 / Math.PI;
          if (Math.abs(actualDeg - expectedDeg) > 0.3) failures.push(`${expected.clip} ${order} at ${expected.time}s: expected ${expectedDeg}deg, got ${actualDeg.toFixed(2)}deg`);
        });
      }
      return { failures };
    },
    { expectedAssetName: model.expectedAsset, expectedClipPoses: model.expectedClipPoses },
  );
  if (result.error || result.failures.length) throw new Error(`${model.name} documented clip poses failed: ${result.error ?? result.failures.join('; ')}`);
};

if (!existsSync(viteBin)) {
  console.error('Vite is not installed. Run npm.cmd install first.');
  process.exit(1);
}

for (const model of models) {
  if (!existsSync(model.path)) {
    console.error(`Missing cell rig model: ${model.path}`);
    process.exit(1);
  }
  const header = readFileSync(model.path).subarray(0, 48).toString('utf8');
  if (header.startsWith('version https://git-lfs.github.com/spec/v1')) {
    console.error(`Cell rig model is still a Git LFS pointer: ${model.path}`);
    process.exit(1);
  }
}

const server = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});

const serverLogs = [];
server.stdout.on('data', (chunk) => serverLogs.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLogs.push(String(chunk)));

try {
  await waitForServer(`http://127.0.0.1:${port}`);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const model of models) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
      const page = await context.newPage();
      const logs = [];
      page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
      page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

      await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('input[accept*=".3ds"]').setInputFiles(model.path);
      await page.waitForFunction((expectedText) => document.body.innerText.includes(expectedText), model.expectedAsset, { timeout: 120000 });
      await page.waitForFunction(
        (expectedAssetName) => window.__assetForgeDocument?.nodes.some((node) => node.geometry?.assetName === expectedAssetName && node.geometry?.kinematicGraph),
        model.expectedAsset,
        { timeout: 30000 },
      );
      await page.waitForFunction(() => window.__assetForgeViewportFrameModel?.(), undefined, { timeout: 30000 });
      await page.waitForTimeout(900);

      const snapshot = await page.evaluate((expectedAssetName) => {
        const node = window.__assetForgeDocument?.nodes.find((item) => item.geometry?.assetName === expectedAssetName);
        const graph = node?.geometry?.kinematicGraph;
        return {
          assetName: node?.geometry?.assetName,
          analysisVersion: graph?.analysisVersion,
          joints: graph?.joints?.map((joint) => ({
            name: joint.name,
            type: joint.type,
            axis: joint.evidence?.[0]?.metadata?.rigAxis,
            coupling: joint.coupling,
            status: joint.status,
          })),
          clips: graph?.motionClips?.map((clip) => ({ name: clip.name, keyframes: clip.keyframes.length })),
          issues: window.__assetForgeDocument?.nodes?.length,
        };
      }, model.expectedAsset);

      if (snapshot.analysisVersion !== model.analysisVersion) {
        throw new Error(`${model.name} analysis version ${snapshot.analysisVersion} did not match ${model.analysisVersion}`);
      }
      for (const jointName of model.jointNames) {
        const joint = snapshot.joints?.find((candidate) => candidate.name === jointName);
        if (!joint) throw new Error(`${model.name} did not recover joint ${jointName}`);
        if (joint.axis !== model.axes[jointName]) throw new Error(`${model.name} joint ${jointName} axis ${joint.axis} did not match ${model.axes[jointName]}`);
        if (joint.status !== 'validated') throw new Error(`${model.name} joint ${jointName} is not validated`);
      }
      for (const clipName of model.clipNames) {
        const clip = snapshot.clips?.find((candidate) => candidate.name === clipName);
        if (!clip) throw new Error(`${model.name} did not recover clip ${clipName}`);
        if (clip.keyframes < 2) throw new Error(`${model.name} clip ${clipName} has too few keyframes`);
      }
      await verifyDocumentedClipPoses(page, model);
      await verifyStaticRigPivotPlacement(page, model);
      await verifyStaticRigChainStability(page, model);
      if (/Industrial/i.test(model.name)) {
        const rightFinger = snapshot.joints?.find((candidate) => candidate.name === 'G1_finger_R');
        if (!rightFinger?.coupling || rightFinger.coupling.multiplier !== -1) throw new Error(`${model.name} gripper mimic coupling is missing`);
      }

      const motion = await verifyMotionChanges(page, model);
      if (motion.error || motion.changed < 1) throw new Error(`${model.name} did not apply a real clip motion: ${motion.error ?? motion.changed}`);
      await page.waitForTimeout(350);
      await verifyEndEffectorIntegrity(page, model);
      await verifyAutoButtonMotion(page, model);
      await verifyIndustrialMaterialEditing(page, model);
      const visiblePixels = await countVisiblePixels(page);
      const errors = logs.filter((line) => line.startsWith('error') || line.startsWith('pageerror'));
      if (errors.length) throw new Error(`${model.name} produced browser errors: ${errors.join('\n')}`);
      if (visiblePixels < 280) throw new Error(`${model.name} render appears blank after motion; visible pixel score ${visiblePixels}`);

      console.log(`${model.name}: ${snapshot.joints.length} joints, ${snapshot.clips.length} clips, clip ${motion.clipName}, visible ${visiblePixels}`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
  if (server.exitCode === 1 && serverLogs.length) console.error(serverLogs.join('\n'));
}
