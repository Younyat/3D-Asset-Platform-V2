import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve('.');
const port = Number(process.env.INDUSTRIAL_SCENE_TEST_PORT ?? 5241);
const viteBin = resolve('node_modules', 'vite', 'bin', 'vite.js');

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
    for (let index = 0; index < pixels.length; index += 120) sample.push(pixels[index], pixels[index + 1], pixels[index + 2]);
    return sample;
  });

const countVisiblePixels = async (page) =>
  page.locator('canvas').evaluate((canvas) => {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) || canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return 0;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let visible = 0;
    for (let y = 0; y < canvas.height; y += 10) {
      for (let x = 0; x < canvas.width; x += 10) {
        const index = (y * canvas.width + x) * 4;
        const diff = Math.abs(pixels[index] - 32) + Math.abs(pixels[index + 1] - 35) + Math.abs(pixels[index + 2] - 38);
        if (diff > 45) visible += 1;
      }
    }
    return visible;
  });

const changedSamples = (before, after) => {
  let changed = 0;
  const length = Math.min(before.length, after.length);
  for (let index = 0; index < length; index += 3) {
    const diff = Math.abs(before[index] - after[index]) + Math.abs(before[index + 1] - after[index + 1]) + Math.abs(before[index + 2] - after[index + 2]);
    if (diff > 18) changed += 1;
  }
  return changed;
};

const documentSnapshot = (page) => page.evaluate(() => window.__assetForgeDocument);

if (!existsSync(viteBin)) {
  console.error('Vite is not installed. Run npm.cmd install first.');
  process.exit(1);
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    const logs = [];
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Industrial Cell' }).click();
    await page.waitForFunction(() => window.__assetForgeDocument?.nodes?.some((node) => node.geometry?.generatorId === 'industrial-gantry-5axis'), undefined, { timeout: 30000 });
    await page.waitForTimeout(1000);

    const doc = await documentSnapshot(page);
    const expected = {
      'industrial-inspection-machine': 4,
      'industrial-conveyor-segment': 3,
      'industrial-gantry-5axis': 8,
      'industrial-operator': 9,
      'industrial-cargo-box': 1,
      'industrial-cargo-stack': 0,
    };
    for (const [generatorId, minJoints] of Object.entries(expected)) {
      const nodes = doc.nodes.filter((node) => node.geometry?.generatorId === generatorId);
      if (!nodes.length) throw new Error(`Missing industrial scene node ${generatorId}`);
      for (const node of nodes) {
        const graph = node.geometry.kinematicGraph;
        const state = node.geometry.kinematicState;
        if (!graph) throw new Error(`${node.name} has no KinematicGraph`);
        if (graph.joints.length < minJoints) throw new Error(`${node.name} has ${graph.joints.length} joints, expected at least ${minJoints}`);
        if (graph.joints.length && !state) throw new Error(`${node.name} has joints but no KinematicState`);
        const missingHome = graph.joints.filter((joint) => state && !(joint.id in state.homeJointValues));
        if (missingHome.length) throw new Error(`${node.name} has joints missing home state: ${missingHome.map((joint) => joint.id).join(', ')}`);
      }
    }
    const looseBoxes = doc.nodes.filter((node) => node.geometry?.generatorId === 'industrial-cargo-box' && /^Loose Box /i.test(node.name));
    if (looseBoxes.length < 4) throw new Error(`Expected at least 4 loose floor boxes, found ${looseBoxes.length}`);
    for (const box of looseBoxes) {
      if (Math.abs(box.transform.position[1]) > 0.0001) throw new Error(`${box.name} is not on the floor at import`);
    }

    const visiblePixels = await countVisiblePixels(page);
    if (visiblePixels < 320) throw new Error(`Industrial scene render appears blank; visible pixel score ${visiblePixels}`);

    const beforeCellCycle = await canvasSample(page);
    await page.getByRole('button', { name: 'Cell Cycle' }).click();
    await page.waitForTimeout(5200);
    const afterCellCycle = await canvasSample(page);
    const cellCycleChanged = changedSamples(beforeCellCycle, afterCellCycle);
    if (cellCycleChanged < 120) throw new Error(`Complete cell cycle did not visibly animate the scene; changed samples ${cellCycleChanged}`);
    const noPickupDebug = await page.evaluate(() => window.__assetForgeViewportIndustrialCellDebug?.());
    const movedWithoutContact = noPickupDebug?.looseCargo?.some((box) => box.picked || box.touched || box.released);
    if (movedWithoutContact) {
      throw new Error('A loose box was picked without contact; the arm must move empty when no box is placed at the gripper.');
    }
    await page.getByRole('button', { name: 'Cell Cycle' }).click();

    await page.evaluate(() => window.__assetForgeViewportPlaceLooseCargoAtGrip?.());
    await page.getByRole('button', { name: 'Cell Cycle' }).click();
    await page.waitForFunction(
      () => {
        window.__assetForgeViewportPlaceLooseCargoAtGrip?.();
        const debug = window.__assetForgeViewportIndustrialCellDebug?.();
        return debug?.cargoA1?.picked === true && typeof debug.cargoGripDistance === 'number' && debug.cargoGripDistance < 0.5;
      },
      undefined,
      { timeout: 15000 },
    );
    await page.waitForFunction(
      () => {
        const debug = window.__assetForgeViewportIndustrialCellDebug?.();
        return debug?.cargoA1?.released === true && debug.cargoA1.position[1] > 0.78 && debug.cargoA1.position[1] < 0.95;
      },
      undefined,
      { timeout: 15000 },
    );
    await page.getByRole('button', { name: 'Cell Cycle' }).click();

    const gantry = doc.nodes.find((node) => node.geometry?.generatorId === 'industrial-gantry-5axis');
    const conveyor = doc.nodes.find((node) => node.geometry?.generatorId === 'industrial-conveyor-segment');
    const box = doc.nodes.find((node) => node.geometry?.generatorId === 'industrial-cargo-box');
    const operator = doc.nodes.find((node) => node.geometry?.generatorId === 'industrial-operator');
    const beforeMotion = await canvasSample(page);
    await page.evaluate(
      ({ gantryId, conveyorId, boxId, operatorId }) => {
        window.__assetForgeSetKinematicJointValues?.(gantryId, { G1: -0.9, G2: 0.5, G3: -0.5, G4: 1.2, G5_0: -0.12 });
        window.__assetForgeSetKinematicJointValues?.(conveyorId, { A_R1: -18, A_S1: 0 });
        window.__assetForgeSetKinematicJointValues?.(boxId, { L1: 1.4 });
        window.__assetForgeSetKinematicJointValues?.(operatorId, { O1: 0.4, O4: 0.5, O6: 1.1, O7: 1.8 });
      },
      { gantryId: gantry.id, conveyorId: conveyor.id, boxId: box.id, operatorId: operator.id },
    );
    await page.waitForTimeout(900);
    const afterMotion = await canvasSample(page);
    const changed = changedSamples(beforeMotion, afterMotion);
    if (changed < 80) throw new Error(`Industrial joint motion did not visibly change the scene; changed samples ${changed}`);

    await page.evaluate((nodeId) => {
      const node = window.__assetForgeDocument.nodes.find((item) => item.id === nodeId);
      window.__assetForgeSetKinematicJointValues?.(
        nodeId,
        Object.fromEntries(node.geometry.kinematicGraph.joints.map((joint) => [joint.id, node.geometry.kinematicState.homeJointValues[joint.id]])),
      );
    }, gantry.id);
    await page.waitForTimeout(300);
    const resetDoc = await documentSnapshot(page);
    const resetGantry = resetDoc.nodes.find((node) => node.id === gantry.id);
    if (Math.abs(resetGantry.geometry.kinematicState.jointValues.G2 - 0.28) > 0.0001 || Math.abs(resetGantry.geometry.kinematicState.jointValues.G5_0 - (24 * Math.PI) / 180) > 0.0001) {
      throw new Error('Gantry home reset did not restore documented home values');
    }

    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('button.generator-item').filter({ hasText: 'Industrial Gantry 5-Axis' }).click();
    await page.waitForFunction(
      () =>
        window.__assetForgeDocument?.nodes.length === 1 &&
        window.__assetForgeDocument.nodes[0]?.geometry?.generatorId === 'industrial-gantry-5axis' &&
        window.__assetForgeDocument.nodes[0]?.geometry?.kinematicGraph?.joints?.length >= 8,
      undefined,
      { timeout: 30000 },
    );
    await page.waitForTimeout(600);
    const individualVisible = await countVisiblePixels(page);
    if (individualVisible < 250) throw new Error(`Individual gantry model appears blank; visible pixel score ${individualVisible}`);

    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Real Cell' }).click();
    await page.waitForFunction(
      () =>
        window.__assetForgeDocument?.nodes?.some((node) => node.geometry?.assetName === 'scenario_1/gantry-robot.glb') &&
        window.__assetForgeDocument?.nodes?.some((node) => node.geometry?.assetName === 'scenario_1/conveyor-segment.glb') &&
        window.__assetForgeDocument?.nodes?.some((node) => node.geometry?.assetName === 'scenario_1/cargo-box.glb'),
      undefined,
      { timeout: 30000 },
    );
    await page.waitForTimeout(1400);
    const realDoc = await documentSnapshot(page);
    const realImported = realDoc.nodes.filter((node) => node.geometry?.kind === 'imported-model' && /^scenario_1\//.test(node.geometry.assetName));
    if (realImported.length < 10) throw new Error(`Real Cell should load imported GLB nodes; found ${realImported.length}`);
    const realLooseBoxes = realDoc.nodes.filter((node) => node.geometry?.assetName === 'scenario_1/cargo-box.glb' && /^Loose Box /i.test(node.name));
    if (realLooseBoxes.length < 4) throw new Error(`Expected at least 4 real loose floor boxes, found ${realLooseBoxes.length}`);
    const realVisible = await countVisiblePixels(page);
    if (realVisible < 420) throw new Error(`Real Cell render appears blank; visible pixel score ${realVisible}`);

    const realBeforeCycle = await canvasSample(page);
    await page.getByRole('button', { name: 'Cell Cycle' }).click();
    await page.waitForTimeout(5200);
    const realAfterCycle = await canvasSample(page);
    const realCycleChanged = changedSamples(realBeforeCycle, realAfterCycle);
    if (realCycleChanged < 120) throw new Error(`Real Cell cycle did not visibly animate; changed samples ${realCycleChanged}`);
    const realNoPickupDebug = await page.evaluate(() => window.__assetForgeViewportIndustrialCellDebug?.());
    if (realNoPickupDebug?.looseCargo?.some((box) => box.picked || box.touched || box.released)) {
      throw new Error('A real loose box was picked without contact.');
    }
    await page.getByRole('button', { name: 'Cell Cycle' }).click();

    await page.evaluate(() => window.__assetForgeViewportPlaceLooseCargoAtGrip?.());
    await page.getByRole('button', { name: 'Cell Cycle' }).click();
    await page.waitForFunction(
      () => {
        window.__assetForgeViewportPlaceLooseCargoAtGrip?.();
        const debug = window.__assetForgeViewportIndustrialCellDebug?.();
        return debug?.cargoA1?.picked === true && typeof debug.cargoGripDistance === 'number' && debug.cargoGripDistance < 0.5;
      },
      undefined,
      { timeout: 15000 },
    );
    await page.waitForFunction(
      () => {
        const debug = window.__assetForgeViewportIndustrialCellDebug?.();
        return debug?.cargoA1?.released === true && debug.cargoA1.position[1] > 0.78 && debug.cargoA1.position[1] < 0.95;
      },
      undefined,
      { timeout: 15000 },
    );
    await page.getByRole('button', { name: 'Cell Cycle' }).click();

    const errors = logs.filter((line) => line.startsWith('error') || line.startsWith('pageerror'));
    if (errors.length) throw new Error(`Browser errors during industrial scene regression:\n${errors.join('\n')}`);
    console.log(`Industrial scene regression passed: ${doc.nodes.length} generated nodes, ${realImported.length} real GLB nodes, visible pixel score ${visiblePixels}, real visible ${realVisible}, cell cycle changed samples ${cellCycleChanged}, real cycle changed samples ${realCycleChanged}, joint changed samples ${changed}`);
    await context.close();
  } finally {
    await browser.close();
  }
} catch (error) {
  if (serverLogs.length) {
    console.error('Vite logs:');
    console.error(serverLogs.join('').trim());
  }
  throw error;
} finally {
  server.kill();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  if (server.exitCode === null) server.kill('SIGKILL');
}
