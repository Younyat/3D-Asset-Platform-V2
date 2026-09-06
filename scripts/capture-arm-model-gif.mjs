import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { encodeGif } from './gif-encoder.mjs';

const root = resolve('.');
const port = Number(process.env.ARM_GIF_PORT ?? 5223);
const viteBin = resolve('node_modules', 'vite', 'bin', 'vite.js');
const modelPath = resolve(process.env.ARM_MODEL_PATH ?? '');
const outputPath = resolve(process.env.ARM_GIF_OUTPUT ?? 'docs/readme-assets/arm-motion.gif');
const label = process.env.ARM_GIF_LABEL ?? basename(modelPath);
const frameCount = Number(process.env.ARM_GIF_FRAMES ?? 14);
const requestedClipName = process.env.ARM_CLIP_NAME;
const minChangedSamples = Number(process.env.ARM_GIF_MIN_CHANGED ?? 80);
const requestedCamera = process.env.ARM_GIF_CAMERA ? JSON.parse(process.env.ARM_GIF_CAMERA) : undefined;
const startRatio = Math.min(0.95, Math.max(0, Number(process.env.ARM_GIF_START_RATIO ?? 0)));
const endRatio = Math.min(1, Math.max(startRatio + 0.01, Number(process.env.ARM_GIF_END_RATIO ?? 1)));

if (!process.env.ARM_MODEL_PATH) throw new Error('ARM_MODEL_PATH is required.');
if (!existsSync(viteBin)) throw new Error('Vite is not installed. Run npm.cmd install first.');
if (!existsSync(modelPath)) throw new Error(`Model not found: ${modelPath}`);

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

const captureCanvasFrame = (page) =>
  page.locator('canvas').evaluate((canvas) => {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) || canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL context unavailable for GIF capture.');
    const width = 640;
    const height = Math.max(1, Math.round((canvas.height / canvas.width) * width));
    const source = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const frame = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.min(canvas.height - 1, canvas.height - 1 - Math.floor((y / height) * canvas.height));
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(canvas.width - 1, Math.floor((x / width) * canvas.width));
        const sourceOffset = (sourceY * canvas.width + sourceX) * 4;
        const targetOffset = (y * width + x) * 4;
        frame[targetOffset] = source[sourceOffset];
        frame[targetOffset + 1] = source[sourceOffset + 1];
        frame[targetOffset + 2] = source[sourceOffset + 2];
        frame[targetOffset + 3] = 255;
      }
    }
    const chunkSize = 0x8000;
    let binary = '';
    for (let index = 0; index < frame.length; index += chunkSize) binary += String.fromCharCode(...frame.subarray(index, index + chunkSize));
    return { width, height, pixels: btoa(binary) };
  });

const changedPixelSamples = (a, b) => {
  const count = Math.min(a.length, b.length);
  let changed = 0;
  for (let index = 0; index < count; index += 24) {
    const diff = Math.abs(a[index] - b[index]) + Math.abs(a[index + 1] - b[index + 1]) + Math.abs(a[index + 2] - b[index + 2]);
    if (diff > 24) changed += 1;
  }
  return changed;
};

const makeJointValues = (page, step, total) =>
  page.evaluate(
    ({ frameStep, frameTotal, clipName, captureStartRatio, captureEndRatio }) => {
      const node = window.__assetForgeDocument?.nodes.find((item) => item.geometry?.kind === 'imported-model');
      const geometry = node?.geometry;
      const graph = geometry?.kinematicGraph;
      if (!node || !graph?.joints?.length) return undefined;
      const clips = graph.motionClips ?? [];
      const preferredClip =
        clips.find((clip) => clipName && clip.name === clipName) ??
        clips.find((clip) => /ciclo|toma|asistencia|transporte|pick|place/i.test(clip.name)) ??
        clips[0];
      if (preferredClip?.keyframes?.length) {
        const duration = Math.max(preferredClip.duration ?? 0, preferredClip.keyframes[preferredClip.keyframes.length - 1]?.time ?? 0.001, 0.001);
        const normalizedTime = captureStartRatio + ((captureEndRatio - captureStartRatio) * frameStep) / Math.max(1, frameTotal - 1);
        const time = normalizedTime * duration;
        const sorted = [...preferredClip.keyframes].sort((a, b) => a.time - b.time);
        let previous = sorted[0];
        let next = sorted[sorted.length - 1];
        for (let index = 0; index < sorted.length - 1; index += 1) {
          if (time >= sorted[index].time && time <= sorted[index + 1].time) {
            previous = sorted[index];
            next = sorted[index + 1];
            break;
          }
        }
        const span = Math.max(0.0001, next.time - previous.time);
        const alpha = Math.min(1, Math.max(0, (time - previous.time) / span));
        const values = {};
        const ids = new Set([...Object.keys(previous.jointValues ?? {}), ...Object.keys(next.jointValues ?? {})]);
        ids.forEach((jointId) => {
          const a = previous.jointValues?.[jointId] ?? next.jointValues?.[jointId] ?? 0;
          const b = next.jointValues?.[jointId] ?? previous.jointValues?.[jointId] ?? 0;
          values[jointId] = a + (b - a) * alpha;
        });
        return { nodeId: node.id, values, jointCount: Object.keys(values).length, clipName: preferredClip.name };
      }
      const home = geometry.kinematicState?.homeJointValues ?? {};
      const normalizedTime = captureStartRatio + ((captureEndRatio - captureStartRatio) * frameStep) / Math.max(1, frameTotal - 1);
      const phaseBase = normalizedTime * Math.PI * 2;
      const values = {};
      graph.joints
        .filter((joint) => joint.type !== 'fixed' && joint.status !== 'rejected')
        .slice(0, 8)
        .forEach((joint, index) => {
          const lower = Number.isFinite(joint.limits?.lower) ? joint.limits.lower : joint.type === 'prismatic' ? -0.12 : -Math.PI;
          const upper = Number.isFinite(joint.limits?.upper) ? joint.limits.upper : joint.type === 'prismatic' ? 0.12 : Math.PI;
          const span = Math.max(upper - lower, joint.type === 'prismatic' ? 0.08 : 0.4);
          const amplitude = Math.min(span * 0.28, joint.type === 'prismatic' ? 0.075 : 0.7);
          const center = Math.min(upper - amplitude, Math.max(lower + amplitude, Number.isFinite(home[joint.id]) ? home[joint.id] : (lower + upper) / 2));
          values[joint.id] = center + Math.sin(phaseBase + index * 0.72) * amplitude;
        });
      return { nodeId: node.id, values, jointCount: Object.keys(values).length, clipName: 'fallback' };
    },
    { frameStep: step, frameTotal: total, clipName: requestedClipName, captureStartRatio: startRatio, captureEndRatio: endRatio },
  );

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
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    const page = await context.newPage();
    const logs = [];
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('input[accept*=".3ds"]').setInputFiles(modelPath);
    await page.waitForFunction((expected) => document.body.innerText.includes(expected), basename(modelPath), { timeout: 180000 });
    await page.waitForFunction(() => window.__assetForgeDocument?.nodes.some((node) => node.geometry?.kind === 'imported-model'), undefined, { timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.waitForFunction(() => window.__assetForgeViewportPrepareCapture?.(), undefined, { timeout: 30000 });
    await page.waitForFunction(() => window.__assetForgeViewportFrameModel?.(), undefined, { timeout: 30000 });
    if (requestedCamera) {
      await page.waitForFunction((camera) => window.__assetForgeViewportSetCamera?.(camera), requestedCamera, { timeout: 30000 });
    }
    await page.waitForTimeout(500);

    const frames = [];
    let animatedJointCount = 0;
    let activeClipName = 'unknown';
    for (let index = 0; index < frameCount; index += 1) {
      const update = await makeJointValues(page, index, frameCount);
      if (!update?.nodeId || !update.jointCount) throw new Error(`${label} has no movable KinematicGraph joints for full-arm capture.`);
      animatedJointCount = update.jointCount;
      activeClipName = update.clipName ?? activeClipName;
      await page.evaluate(({ nodeId, values }) => window.__assetForgeSetKinematicJointValues?.(nodeId, values), update);
      await page.waitForTimeout(180);
      frames.push(await captureCanvasFrame(page));
    }

    const decoded = frames.map((frame) => ({ width: frame.width, height: frame.height, pixels: Buffer.from(frame.pixels, 'base64') }));
    const maxChanged = decoded.slice(1).reduce((best, frame) => Math.max(best, changedPixelSamples(decoded[0].pixels, frame.pixels)), 0);
    if (maxChanged < minChangedSamples) throw new Error(`${label} motion is not visibly different (${maxChanged} changed samples).`);

    const gif = encodeGif({ width: decoded[0].width, height: decoded[0].height, frames: decoded, delayCentiseconds: 55 });
    await page.setContent(`<img id="gif-validation" src="data:image/gif;base64,${gif.toString('base64')}" alt="${label} motion validation">`);
    const image = page.locator('#gif-validation');
    await image.waitFor({ state: 'visible' });
    const firstRender = await image.screenshot();
    let animatedBytes = 0;
    for (const delay of [520, 940, 1370]) {
      await page.waitForTimeout(delay);
      const nextRender = await image.screenshot();
      for (let index = 0; index < Math.min(firstRender.length, nextRender.length); index += 29) {
        if (firstRender[index] !== nextRender[index]) animatedBytes += 1;
      }
      if (animatedBytes >= 12) break;
    }
    if (animatedBytes < 12) console.warn(`${label} GIF render probe stayed on one frame (${animatedBytes} changed render samples); source frames passed with ${maxChanged} changed samples.`);

    const errors = logs.filter((line) => line.startsWith('error') || line.startsWith('pageerror'));
    if (errors.length) throw new Error(`${label} produced browser errors: ${errors.join('\n')}`);

    writeFileSync(outputPath, gif);
    console.log(`${label}: ${outputPath} (${animatedJointCount} joints, clip ${activeClipName}, ${maxChanged} changed samples, ${animatedBytes} animated render samples)`);
    await context.close();
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
  if (server.exitCode === 1 && serverLogs.length) console.error(serverLogs.join('\n'));
}
