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
    page.on('console', (message) => {
      const location = message.location();
      logs.push(`${message.type()}: ${message.text()}${location.url ? ` @ ${location.url}:${location.lineNumber}` : ''}`);
    });
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Industrial Cell/ }).click();
    await page.getByRole('button', { name: /Industrial Gantry Robot/ }).click();
    await page.locator('.workbench > .viewport canvas').waitFor({ timeout: 30000 });
    await page.waitForTimeout(1200);

    const settingsToggle = page.getByRole('button', { name: 'Open internal configuration center' });
    await settingsToggle.click();
    const settingsCenter = page.getByLabel('Internal PLC configuration center');
    await settingsCenter.waitFor({ state: 'visible', timeout: 30000 });
    await settingsCenter.getByText('Internal Configuration Center').waitFor();
    if (!/Wire\s+%QWn\s+maps to conventional holding register/.test(await settingsCenter.innerText())) throw new Error('Internal configuration center does not explain Wire/HR conversion.');
    const initialDefinitionCount = await settingsCenter.locator('.internal-register-row').count();
    if (initialDefinitionCount < 15) throw new Error(`Expected system and robot register definitions, found ${initialDefinitionCount}.`);
    const commandWireInput = settingsCenter.locator('.internal-register-row').first().locator('input[type="number"]');
    if (await commandWireInput.isEnabled()) throw new Error('Sensitive register input must be read-only before Enable editing.');
    const editConfiguration = settingsCenter.getByRole('button', { name: 'Enable editing' });
    await editConfiguration.click();
    if (!await settingsCenter.getByRole('button', { name: 'Editing enabled' }).evaluate((element) => element.classList.contains('editing'))) throw new Error('Edit mode did not expose its active green state.');
    await commandWireInput.fill('89');
    if (await page.evaluate(() => JSON.parse(localStorage.getItem('assetForge.internalRegisterConfiguration.v1') ?? '[]').some((entry) => entry.id === 'system-command' && entry.wire === 89))) throw new Error('Unconfirmed draft was persisted before confirmation.');
    await settingsCenter.getByRole('button', { name: /Add register/ }).click();
    if (await settingsCenter.locator('.internal-register-row').count() !== initialDefinitionCount + 1) throw new Error('Add register did not create an editable definition.');
    await settingsCenter.getByRole('button', { name: /Save changes/ }).click();
    const saveConfirmation = page.getByRole('dialog', { name: 'Confirm sensitive configuration changes' });
    await saveConfirmation.waitFor({ state: 'visible' });
    await saveConfirmation.getByRole('button', { name: 'Confirm and save' }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('assetForge.internalRegisterConfiguration.v1') ?? '[]').some((entry) => entry.id === 'system-command' && entry.wire === 89));
    await settingsCenter.getByRole('button', { name: 'Enable editing' }).click();
    await settingsCenter.getByRole('button', { name: /Restore documented map/ }).click();
    await settingsCenter.getByRole('button', { name: /Save changes/ }).click();
    await page.getByRole('dialog', { name: 'Confirm sensitive configuration changes' }).getByRole('button', { name: 'Confirm and save' }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('assetForge.internalRegisterConfiguration.v1') ?? '[]').some((entry) => entry.id === 'system-command' && entry.wire === 90));
    await settingsCenter.getByRole('button', { name: 'Close internal configuration' }).click();

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
    const traceToggle = page.locator('.trace-audit-edge-toggle');
    await traceToggle.waitFor({ state: 'visible', timeout: 30000 });
    await traceToggle.click();
    const traceDrawer = page.locator('.trace-audit-drawer.open');
    await traceDrawer.waitFor({ state: 'visible', timeout: 30000 });
    const traceCanvas = traceDrawer.locator('.trace-pipeline-3d canvas');
    await traceCanvas.waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(500);
    const traceScreenshot = await traceDrawer.locator('.trace-pipeline-3d').screenshot({ type: 'png' });
    if (traceScreenshot.byteLength < 18000) {
      throw new Error(`Traceability 3D pipeline screenshot is blank or visually under-detailed: ${traceScreenshot.byteLength} bytes.`);
    }
    const drawerBefore = await traceDrawer.boundingBox();
    const widthHandle = traceDrawer.locator('.drawer-width-resize-handle');
    const widthHandleBox = await widthHandle.boundingBox();
    if (!drawerBefore || !widthHandleBox) throw new Error('Trace drawer width handle is not measurable.');
    await page.mouse.move(widthHandleBox.x + widthHandleBox.width / 2, widthHandleBox.y + 120);
    await page.mouse.down();
    await page.mouse.move(widthHandleBox.x - 90, widthHandleBox.y + 120, { steps: 5 });
    await page.mouse.up();
    const drawerAfter = await traceDrawer.boundingBox();
    if (!drawerAfter || drawerAfter.width < drawerBefore.width + 70) throw new Error(`Trace drawer did not expand left: ${drawerBefore.width} -> ${drawerAfter?.width}.`);
    const pipelineBefore = await traceDrawer.locator('.trace-pipeline-3d').boundingBox();
    const heightHandle = traceDrawer.locator('.trace-height-resize-handle').first();
    const heightHandleBox = await heightHandle.boundingBox();
    if (!pipelineBefore || !heightHandleBox) throw new Error('Trace pipeline height handle is not measurable.');
    await page.mouse.move(heightHandleBox.x + heightHandleBox.width / 2, heightHandleBox.y + heightHandleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(heightHandleBox.x + heightHandleBox.width / 2, heightHandleBox.y + 80, { steps: 5 });
    await page.mouse.up();
    const pipelineAfter = await traceDrawer.locator('.trace-pipeline-3d').boundingBox();
    if (!pipelineAfter || pipelineAfter.height < pipelineBefore.height + 65) throw new Error(`Trace pipeline did not grow downward: ${pipelineBefore.height} -> ${pipelineAfter?.height}.`);
    await traceDrawer.getByRole('button', { name: 'Modbus' }).click();
    await page.waitForFunction(
      () => {
        const text = document.querySelector('.trace-audit-drawer.open')?.textContent ?? '';
        return text.includes('%QW90') && text.includes('%QW100..105') && text.includes('%QW127');
      },
      undefined,
      { timeout: 30000 },
    );
    await traceDrawer.getByRole('button', { name: 'Close traceability audit' }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Disconnect Client'), undefined, { timeout: 30000 });
    const disconnectClient = page.getByRole('button', { name: /Disconnect Client/ });
    if (await disconnectClient.isEnabled()) await disconnectClient.click();
    await page.getByRole('button', { name: /^Run$/ }).click();
    await page.waitForFunction(() => /digital twin scenario/i.test(document.body.innerText), undefined, { timeout: 30000 });
    await page.waitForFunction(() => document.body.innerText.includes('Entidad Fisica Simulada') && document.body.innerText.includes('Gemelo Digital'), undefined, { timeout: 30000 });
    await page.waitForFunction(
      () => document.querySelectorAll('.plc-register-control').length > 0 && document.querySelector('.virtual-plc-rack')?.textContent?.includes('RUN'),
      undefined,
      { timeout: 30000 },
    );
    await page.waitForTimeout(1800);
    const after = await canvasSample(page);
    const changed = sampleDiff(before, after);
    if (changed < 8) throw new Error(`PLC dashboard did not visibly move the digital twin. Changed samples: ${changed}.`);

    const plcRack = page.getByLabel('Virtual industrial PLC');
    await plcRack.getByText('RUN', { exact: true }).waitFor();
    if (!/Cycle \d+/.test(await plcRack.innerText())) throw new Error('PLC scan cycle counter is not advancing.');
    await plcRack.getByRole('button', { name: /E-STOP READY/ }).click();
    await plcRack.getByText('FAULT', { exact: true }).waitFor();
    await plcRack.getByText(/E_STOP: Emergency stop circuit is open/).waitFor();
    await plcRack.getByRole('button', { name: 'RESET FAULT' }).click();
    await plcRack.getByText('FAULT', { exact: true }).waitFor();
    await plcRack.getByRole('button', { name: /E-STOP TRIPPED/ }).click();
    await plcRack.getByRole('button', { name: 'RESET FAULT' }).click();
    await plcRack.getByText('STOP', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^Run$/ }).click();
    await plcRack.getByText('RUN', { exact: true }).waitFor();

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
    const resizeHandle = page.locator('.plc-mirror-resize-handle');
    const views = page.locator('.plc-robot-view');
    const initialViewBox = await views.nth(0).boundingBox();
    const handleBox = await resizeHandle.boundingBox();
    if (!initialViewBox || !handleBox) throw new Error('PLC mirror resize handle is not measurable.');
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y - 90, { steps: 5 });
    await page.mouse.up();
    const expandedPhysicalBox = await views.nth(0).boundingBox();
    const expandedTwinBox = await views.nth(1).boundingBox();
    if (!expandedPhysicalBox || !expandedTwinBox || expandedPhysicalBox.height < initialViewBox.height + 70 || Math.abs(expandedPhysicalBox.height - expandedTwinBox.height) > 1) {
      throw new Error(`PLC mirror resize did not expand both views equally: initial=${initialViewBox.height}, physical=${expandedPhysicalBox?.height}, twin=${expandedTwinBox?.height}.`);
    }
    const expandedHandleBox = await resizeHandle.boundingBox();
    if (!expandedHandleBox) throw new Error('PLC mirror resize handle disappeared after expansion.');
    await page.mouse.move(expandedHandleBox.x + expandedHandleBox.width / 2, expandedHandleBox.y + expandedHandleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(expandedHandleBox.x + expandedHandleBox.width / 2, expandedHandleBox.y + 90, { steps: 5 });
    await page.mouse.up();
    const reducedViewBox = await views.nth(0).boundingBox();
    if (!reducedViewBox || reducedViewBox.height > expandedPhysicalBox.height - 70) throw new Error('PLC mirror resize did not reduce the views when dragged down.');
    await page.getByRole('button', { name: /Local Manual/ }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.plc-register-control input:not([disabled])').length >= 6,
      undefined,
      { timeout: 30000 },
    );
    const manualBefore = await canvasSample(page, twinCanvas);
    const controls = page.locator('.plc-register-control input');
    await controls.nth(0).fill('2.65');
    await page.waitForTimeout(350);
    await controls.nth(2).fill('-2.05');
    await page.waitForTimeout(350);
    await controls.nth(3).fill('2.65');
    await page.waitForTimeout(1800);
    const manualAfter = await canvasSample(page, twinCanvas);
    const manualChanged = sampleDiff(manualBefore, manualAfter);
    const physicalJ1 = Number(await controls.nth(0).inputValue());
    const twinJ1 = Number(await controls.nth(6).inputValue());
    if (Math.abs(physicalJ1 - 2.65) > 0.011 || Math.abs(twinJ1 - physicalJ1) > 0.011) {
      throw new Error(`Manual PLC register did not propagate exactly to the twin: physical=${physicalJ1}, twin=${twinJ1}, pixels=${manualChanged}.`);
    }

    const text = await page.locator('.plc-dashboard').textContent();
    if (!text?.includes('Simulated physical entity') || !text.includes('Digital twin 3D') || !text.includes('Modbus Register Map') || !text.includes('seq')) {
      throw new Error('PLC dashboard did not render physical/twin flow information.');
    }
    const errors = logs.filter(
      (line) =>
        (line.startsWith('error') || line.startsWith('pageerror')) &&
        !line.includes('Failed to load resource: net::ERR_CONNECTION_REFUSED'),
    );
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
