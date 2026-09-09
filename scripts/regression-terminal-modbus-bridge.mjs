import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve('.');
const vitePort = Number(process.env.MODBUS_BRIDGE_TEST_PORT ?? 5211);
const bridgePort = Number(process.env.MODBUS_DRIVER_PORT ?? 8777);
const viteBin = resolve('node_modules', 'vite', 'bin', 'vite.js');
const driverScript = resolve('scripts', 'modbus_visual_controller.mjs');

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

const canvasSample = async (locator) =>
  locator.evaluate((canvas) => {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) || canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return [];
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const sample = [];
    for (let y = 0; y < canvas.height; y += 16) {
      for (let x = 0; x < canvas.width; x += 16) {
        const index = (y * canvas.width + x) * 4;
        sample.push(pixels[index], pixels[index + 1], pixels[index + 2]);
      }
    }
    return sample;
  });

const sampleDiff = (a, b) => {
  const count = Math.min(a.length, b.length);
  let changed = 0;
  for (let index = 0; index < count; index += 3) {
    const diff = Math.abs(a[index] - b[index]) + Math.abs(a[index + 1] - b[index + 1]) + Math.abs(a[index + 2] - b[index + 2]);
    if (diff > 24) changed += 1;
  }
  return changed;
};

if (!existsSync(viteBin)) throw new Error('Vite is not installed. Run npm.cmd install first.');
if (!existsSync(driverScript)) throw new Error('Missing scripts/modbus_visual_controller.mjs.');

const driver = spawn(process.execPath, [driverScript, `--port=${bridgePort}`, '--cycle'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});
const driverLogs = [];
driver.stdout.on('data', (chunk) => driverLogs.push(String(chunk)));
driver.stderr.on('data', (chunk) => driverLogs.push(String(chunk)));

const server = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});
const serverLogs = [];
server.stdout.on('data', (chunk) => serverLogs.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLogs.push(String(chunk)));

try {
  await waitForServer(`http://127.0.0.1:${bridgePort}/state`);
  await fetch(`http://127.0.0.1:${bridgePort}/client-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'regression-visual-controller', status: 'connected', endpoint: `http://127.0.0.1:${bridgePort}` }),
  });
  const stateBefore = await fetch(`http://127.0.0.1:${bridgePort}/state`).then((response) => response.json());
  if (!stateBefore.modbusPackets?.length || !stateBefore.registers?.length) throw new Error('Visual controller did not publish Modbus registers and packets.');
  await waitForServer(`http://127.0.0.1:${vitePort}`);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1480, height: 980 } });
    const page = await context.newPage();
    const logs = [];
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

    await page.goto(`http://127.0.0.1:${vitePort}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((url) => {
      localStorage.clear();
      localStorage.setItem('assetForge.modbusBridgeUrl', url);
    }, `http://127.0.0.1:${bridgePort}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Industrial Cell/ }).click();
    await page.getByRole('button', { name: /Industrial Gantry Robot/ }).click();
    await page.locator('canvas').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(1200);
    await fetch(`http://127.0.0.1:${bridgePort}/client-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'regression-visual-controller', status: 'connected', endpoint: `http://127.0.0.1:${bridgePort}` }),
    });
    await page.getByRole('button', { name: /Digital Twin Scenario/ }).click();
    await page.locator('.plc-dashboard').waitFor({ timeout: 30000 });
    await page.waitForFunction(
      (expectedPort) =>
        document.body.innerText.includes('Modbus Controller Endpoint') &&
        document.body.innerText.includes('RX no') &&
        document.body.innerText.includes('Disconnect Client') &&
        document.body.innerText.includes(String(expectedPort)),
      bridgePort,
      { timeout: 30000 },
    );
    await page.getByRole('button', { name: /Advanced Details/ }).click();
    await page.getByRole('button', { name: /Visual Controller/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Visual Modbus controller online'), undefined, { timeout: 30000 });
    await page.waitForFunction(
      (expectedPort) =>
        document.body.innerText.includes('Modbus Controller Endpoint') &&
        document.body.innerText.includes('RX yes') &&
        document.body.innerText.includes('client connected') &&
        document.body.innerText.includes('127.0.0.1') &&
        document.body.innerText.includes(String(expectedPort)),
      bridgePort,
      { timeout: 30000 },
    );
    await page.waitForFunction(() => document.body.innerText.includes('Live Modbus TCP Packets') && /FC 3|HR 40101|0x/.test(document.body.innerText), undefined, { timeout: 30000 });

    const twinCanvas = page.getByLabel(/Gemelo Digital 3D robot mirror/).locator('canvas');
    await twinCanvas.waitFor({ timeout: 30000 });
    const before = await canvasSample(twinCanvas);
    await fetch(`http://127.0.0.1:${bridgePort}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayAddress: '40103', value: 1.45 }),
    });
    await page.waitForTimeout(1400);
    const after = await canvasSample(twinCanvas);
    const changed = sampleDiff(before, after);
    if (changed < 4) throw new Error(`Terminal Modbus write did not visibly move the digital twin. Changed samples: ${changed}.`);
    await page.getByRole('button', { name: /Disconnect Client/ }).click();
    await page.waitForFunction(
      () =>
        document.body.innerText.includes('Visual Modbus controller client disconnected') &&
        document.body.innerText.includes('controller off') &&
        !document.body.innerText.includes('client connected'),
      undefined,
      { timeout: 30000 },
    );

    const errors = logs.filter((line) => line.startsWith('error') || line.startsWith('pageerror'));
    if (errors.length) throw new Error(`Terminal bridge browser errors:\n${errors.join('\n')}`);
    console.log(`Visual Modbus controller regression passed: digital twin changed ${changed} canvas samples.`);
    await context.close();
  } finally {
    await browser.close();
  }
} catch (error) {
  if (driverLogs.length) console.error(driverLogs.join(''));
  if (serverLogs.length) console.error(serverLogs.join(''));
  throw error;
} finally {
  server.kill();
  driver.kill();
}
