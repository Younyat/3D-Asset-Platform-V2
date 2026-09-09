import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve('.');
const port = Number(process.env.PLC_TEST_PORT ?? 5209);
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

const canvasSample = async (page, locator = page.locator('canvas').first()) =>
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
    const context = await browser.newContext({ viewport: { width: 1480, height: 980 } });
    const page = await context.newPage();
    const logs = [];
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Industrial Cell/ }).click();
    await page.getByRole('button', { name: /Industrial Gantry Robot/ }).click();
    await page.locator('canvas').waitFor({ timeout: 30000 });
    await page.waitForTimeout(1200);

    const before = await canvasSample(page);
    const plcButton = page.getByRole('button', { name: /Digital Twin Scenario/ });
    const plcButtonCount = await plcButton.count();
    if (plcButtonCount !== 1) throw new Error(`Expected one visible Digital Twin Scenario button, found ${plcButtonCount}.`);
    const plcBox = await plcButton.boundingBox();
    const cellBox = await page.getByRole('button', { name: /Cell Cycle/ }).boundingBox();
    const viewport = page.viewportSize();
    if (!plcBox || !cellBox || !viewport) throw new Error('Could not measure Digital Twin Scenario and Cell Cycle button positions.');
    if (plcBox.x < 0 || plcBox.y < 0 || plcBox.x + plcBox.width > viewport.width || plcBox.y + plcBox.height > viewport.height) {
      throw new Error(`Digital Twin Scenario button is outside the viewport: ${JSON.stringify(plcBox)} in ${JSON.stringify(viewport)}.`);
    }
    if (plcBox.x >= cellBox.x) throw new Error('Digital Twin Scenario button must be placed immediately before the Cell Cycle group.');
    const plcBackground = await plcButton.evaluate((element) => getComputedStyle(element).backgroundColor);
    if (!plcBackground.includes('196, 81, 20') && !plcBackground.includes('232, 102, 31')) {
      throw new Error(`Digital Twin Scenario button does not have the expected distinctive orange background: ${plcBackground}.`);
    }
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.waitForTimeout(250);
    const compactBox = await plcButton.boundingBox();
    const compactViewport = page.viewportSize();
    if (!compactBox || !compactViewport || compactBox.x < 0 || compactBox.x + compactBox.width > compactViewport.width || compactBox.y < 0) {
      throw new Error(`Digital Twin Scenario button is not visible at 1280px: ${JSON.stringify(compactBox)} in ${JSON.stringify(compactViewport)}.`);
    }
    await page.setViewportSize({ width: 1480, height: 980 });
    await page.waitForTimeout(250);
    await plcButton.click();
    await page.locator('.plc-dashboard').waitFor({ timeout: 30000 });
    await page.waitForFunction(() => document.body.innerText.includes('Disconnect Client'), undefined, { timeout: 30000 });
    await page.getByRole('button', { name: /^Run$/ }).click();
    await page.waitForFunction(() => /digital twin scenario/i.test(document.body.innerText), undefined, { timeout: 30000 });
    await page.waitForFunction(() => document.body.innerText.includes('Entidad Fisica Simulada') && document.body.innerText.includes('Gemelo Digital'), undefined, { timeout: 30000 });
    await page.waitForFunction(() => /HR 40101|GOOD|Modbus samples reflected/.test(document.body.innerText), undefined, { timeout: 30000 });
    await page.waitForTimeout(1800);
    const after = await canvasSample(page);
    const changed = sampleDiff(before, after);
    if (changed < 8) throw new Error(`PLC dashboard did not visibly move the digital twin. Changed samples: ${changed}.`);

    await page.getByRole('button', { name: /Advanced Details/ }).click();
    await page.waitForFunction(
      () => document.body.innerText.includes('Modbus Register Map') && document.body.innerText.includes('Live Modbus TCP Packets') && /FC 3|HR 40101|0x/.test(document.body.innerText),
      undefined,
      { timeout: 30000 },
    );
    const physicalCanvas = page.getByLabel(/Entidad Fisica Simulada robot mirror/).locator('canvas');
    const twinCanvas = page.getByLabel(/Gemelo Digital 3D robot mirror/).locator('canvas');
    await physicalCanvas.waitFor({ timeout: 30000 });
    await twinCanvas.waitFor({ timeout: 30000 });
    const dashboardCanvasCount = await page.locator('.plc-robot-view canvas').count();
    if (dashboardCanvasCount !== 2) throw new Error(`Expected two real Three.js robot mirrors in the PLC dashboard, found ${dashboardCanvasCount}.`);
    const manualBefore = await canvasSample(page, twinCanvas);
    const controls = page.locator('.plc-register-control input');
    await controls.nth(1).evaluate((input) => {
      input.value = '1.65';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await controls.nth(2).evaluate((input) => {
      input.value = '-2.05';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await controls.nth(3).evaluate((input) => {
      input.value = '2.65';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(1800);
    const manualAfter = await canvasSample(page, twinCanvas);
    const manualChanged = sampleDiff(manualBefore, manualAfter);
    if (manualChanged < 1) throw new Error(`Manual PLC register edit did not visibly move the digital twin. Changed samples: ${manualChanged}.`);

    const text = await page.locator('.plc-dashboard').textContent();
    if (!text?.includes('Simulated physical entity') || !text.includes('Digital twin 3D') || !text.includes('Modbus Register Map') || !text.includes('seq')) {
      throw new Error('PLC dashboard did not render physical/twin flow information.');
    }
    const errors = logs.filter((line) => line.startsWith('error') || line.startsWith('pageerror'));
    if (errors.length) throw new Error(`PLC dashboard browser errors:\n${errors.join('\n')}`);
    console.log(`PLC dashboard regression passed: visible digital twin motion changed ${changed} canvas samples.`);
    await context.close();
  } finally {
    await browser.close();
  }
} catch (error) {
  if (serverLogs.length) console.error(serverLogs.join(''));
  throw error;
} finally {
  server.kill();
}
