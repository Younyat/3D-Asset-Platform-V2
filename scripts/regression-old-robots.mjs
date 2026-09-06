import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const port = Number(process.env.OLD_ROBOTS_TEST_PORT ?? 5261);
const viteBin = resolve('node_modules', 'vite', 'bin', 'vite.js');

const models = [
  {
    name: 'old_robots OBJ_Robot',
    path: resolve('3d imported models', 'old_robots', 'OBJ_Robot.obj'),
    expectedText: 'OBJ_Robot.obj',
    expectedVersion: 'professional-rig-1.3-old-irobot-static-obj',
    expectedJoints: 7,
    expectedMorphologyJoints: 2,
  },
  {
    name: 'old_robots Rmk3',
    path: resolve('3d imported models', 'old_robots', 'Rmk3.obj'),
    expectedText: 'Rmk3.obj',
    expectedVersion: 'professional-rig-1.3-old-rmk3-static-obj',
    expectedJoints: 8,
    expectedMorphologyJoints: 2,
  },
  {
    name: 'old_robots IRAmk4',
    path: resolve('3d imported models', 'old_robots', 'IRAmk4.3ds'),
    expectedText: 'IRAmk4.3ds',
    expectedVersion: 'professional-rig-1.3-old-iramk4-static-obj',
    expectedJoints: 5,
    expectedMorphologyJoints: 1,
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

const canvasSample = async (page) =>
  page.locator('canvas').evaluate((canvas) => {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) || canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return [];
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const sample = [];
    for (let y = 0; y < canvas.height; y += 12) {
      for (let x = 0; x < canvas.width; x += 12) {
        const index = (y * canvas.width + x) * 4;
        sample.push(pixels[index], pixels[index + 1], pixels[index + 2]);
      }
    }
    return sample;
  });

const sampleDiff = (a, b) => {
  let changed = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 3) {
    const diff = Math.abs(a[index] - b[index]) + Math.abs(a[index + 1] - b[index + 1]) + Math.abs(a[index + 2] - b[index + 2]);
    if (diff > 26) changed += 1;
  }
  return changed;
};

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 56);

const pivotForJoint = (debug, jointName) => {
  const pivotSlug = `joint_${slug(jointName)}`;
  return debug.objects.find((object) => object.pivot && object.name.toLowerCase().includes(pivotSlug));
};

const verifyMechanicalChain = async (page, model) => {
  const setup = await page.evaluate(() => {
    const node = window.__assetForgeDocument?.nodes.find((item) => item.geometry?.kind === 'imported-model');
    const graph = node?.geometry?.kinematicGraph;
    const state = node?.geometry?.kinematicState;
    const clip = graph?.motionClips?.find((candidate) => /pick|place|ciclo/i.test(candidate.name)) ?? graph?.motionClips?.[0];
    if (!node || !graph || !state || !clip) return undefined;
    const jointByChildPartId = new Map(graph.joints.map((joint) => [joint.childPartId, joint]));
    const partById = new Map(graph.parts.map((part) => [part.id, part]));
    const links = graph.joints
      .map((joint) => {
        const parentJoint = jointByChildPartId.get(joint.parentPartId);
        const parentPart = partById.get(joint.parentPartId);
        if (!parentJoint || parentPart?.static || joint.type === 'prismatic') return undefined;
        return { parent: parentJoint.name, child: joint.name };
      })
      .filter(Boolean);
    const basePart = graph.parts.find((part) => part.static);
    return { nodeId: node.id, home: state.homeJointValues, keyframes: clip.keyframes, links, baseNames: basePart?.meshObjectIds ?? [] };
  });
  if (!setup?.links?.length) throw new Error(`${model.name} did not expose a measurable mechanical chain.`);

  await page.evaluate(({ nodeId, home }) => window.__assetForgeSetKinematicJointValues?.(nodeId, home), setup);
  await page.waitForTimeout(100);
  const baselineDebug = await page.evaluate(() => window.__assetForgeViewportMechanicsDebug?.());
  if (!baselineDebug?.objects?.length) throw new Error(`${model.name} did not expose viewport mechanics debug data.`);
  const baselineLinks = new Map();
  setup.links.forEach((link) => {
    const parent = pivotForJoint(baselineDebug, link.parent);
    const child = pivotForJoint(baselineDebug, link.child);
    if (parent && child) baselineLinks.set(`${link.parent}->${link.child}`, distance(parent.position, child.position));
  });
  const baseReferenceName = setup.baseNames.find((name) => baselineDebug.objects.some((object) => object.name === name));
  const baseReference = baseReferenceName ? baselineDebug.objects.find((object) => object.name === baseReferenceName) : undefined;

  for (let index = 1; index < setup.keyframes.length; index += 1) {
    await page.evaluate(({ nodeId, values }) => window.__assetForgeSetKinematicJointValues?.(nodeId, values), {
      nodeId: setup.nodeId,
      values: setup.keyframes[index].jointValues,
    });
    await page.waitForTimeout(100);
    const debug = await page.evaluate(() => window.__assetForgeViewportMechanicsDebug?.());
    for (const link of setup.links) {
      const key = `${link.parent}->${link.child}`;
      const reference = baselineLinks.get(key);
      const parent = pivotForJoint(debug, link.parent);
      const child = pivotForJoint(debug, link.child);
      if (!parent || !child || !Number.isFinite(reference)) throw new Error(`${model.name} missing pivot link ${key} at keyframe ${index}.`);
      const current = distance(parent.position, child.position);
      const tolerance = /IRAmk4/i.test(model.name) ? 0.08 : 0.025;
      if (Math.abs(current - reference) > tolerance) {
        throw new Error(`${model.name} chain ${key} stretched from ${reference.toFixed(3)} to ${current.toFixed(3)} at keyframe ${index}.`);
      }
    }
    if (baseReferenceName && baseReference) {
      const baseCurrent = debug.objects.find((object) => object.name === baseReferenceName);
      if (baseCurrent && distance(baseReference.position, baseCurrent.position) > 0.01) {
        throw new Error(`${model.name} moved static base ${baseReferenceName} while animating.`);
      }
    }
  }
};

if (!existsSync(viteBin)) throw new Error('Vite is not installed. Run npm.cmd install first.');
for (const model of models) {
  if (!existsSync(model.path)) throw new Error(`Missing old robot model: ${model.path}`);
  const header = readFileSync(model.path).subarray(0, 48).toString('utf8');
  if (header.startsWith('version https://git-lfs.github.com/spec/v1')) throw new Error(`${model.name} is still a Git LFS pointer.`);
}

const server = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});

const logs = [];
server.stdout.on('data', (chunk) => logs.push(String(chunk)));
server.stderr.on('data', (chunk) => logs.push(String(chunk)));

try {
  await waitForServer(`http://127.0.0.1:${port}`);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const model of models) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
      const page = await context.newPage();
      const pageLogs = [];
      page.on('console', (message) => pageLogs.push(`${message.type()}: ${message.text()}`));
      page.on('pageerror', (error) => pageLogs.push(`pageerror: ${error.message}`));
      await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('input[accept*=".3ds"]').setInputFiles(model.path);
      await page.waitForFunction((expectedText) => document.body.innerText.includes(expectedText), model.expectedText, { timeout: 180000 });
      await page.waitForFunction(
        () => window.__assetForgeDocument?.nodes.some((item) => item.geometry?.kind === 'imported-model' && item.geometry?.kinematicGraph),
        undefined,
        { timeout: 30000 },
      );
      await page.waitForFunction(() => window.__assetForgeViewportFrameModel?.(), undefined, { timeout: 30000 });
      await page.waitForTimeout(1200);

      const snapshot = await page.evaluate(() => {
        const node = window.__assetForgeDocument?.nodes.find((item) => item.geometry?.kind === 'imported-model');
        const graph = node?.geometry?.kinematicGraph;
        return {
          version: graph?.analysisVersion,
          joints: graph?.joints?.length ?? 0,
          clips: graph?.motionClips?.map((clip) => clip.name) ?? [],
          state: Boolean(node?.geometry?.kinematicState),
          morphologyJoints: graph?.joints?.filter((joint) => joint.evidence?.some((item) => item.metadata?.morphology?.method === 'rounded-body')).length ?? 0,
        };
      });
      if (snapshot.version !== model.expectedVersion) throw new Error(`${model.name} version ${snapshot.version} did not match ${model.expectedVersion}`);
      if (snapshot.joints !== model.expectedJoints) throw new Error(`${model.name} recovered ${snapshot.joints} joints, expected ${model.expectedJoints}`);
      if (snapshot.morphologyJoints < model.expectedMorphologyJoints) {
        throw new Error(`${model.name} recovered ${snapshot.morphologyJoints} morphology joints, expected at least ${model.expectedMorphologyJoints}.`);
      }
      if (!snapshot.state) throw new Error(`${model.name} did not create a persistent kinematic state.`);
      for (const clip of ['Ciclo_Pick_And_Place', 'Ir_A_Home', 'Demo_Ejes']) {
        if (!snapshot.clips.includes(clip)) throw new Error(`${model.name} did not recover clip ${clip}.`);
      }

      const before = await canvasSample(page);
      await page.locator('.smart-motion-button').click();
      await page.waitForTimeout(1800);
      const during = await canvasSample(page);
      await page.locator('.smart-motion-button').click();
      const changed = sampleDiff(before, during);
      if (changed < 20) throw new Error(`${model.name} did not animate visibly from old_robots; changed samples ${changed}.`);
      await verifyMechanicalChain(page, model);
      const errors = pageLogs.filter((line) => line.startsWith('error') || line.startsWith('pageerror'));
      if (errors.length) throw new Error(`${model.name} produced browser errors: ${errors.join('\n')}`);

      console.log(`${model.name}: ${snapshot.joints} joints, ${snapshot.clips.length} clips, visible motion ${changed}, chain stable`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
  if (server.exitCode === 1 && logs.length) console.error(logs.join('\n'));
}
