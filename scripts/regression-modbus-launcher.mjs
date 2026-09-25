import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const port = Number(process.env.MODBUS_LAUNCHER_TEST_PORT ?? 5216);
const viteBin = resolve('node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: resolve('.'),
  stdio: 'inherit',
  shell: false,
});

const waitForServer = async (url, timeoutMs = 30000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite may still be starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 180));
  }
  throw new Error(`Timed out waiting for ${url}`);
};

let browser;
try {
  await waitForServer(`http://127.0.0.1:${port}`);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });

  const button = page.locator('.modbus-controller-top-button');
  await button.waitFor();
  if (!(await button.isVisible()) || !(await button.isEnabled())) throw new Error('Modbus Controller button is not available in the main dashboard.');

  await button.click();
  const drawer = page.locator('.modbus-controller-drawer');
  await drawer.waitFor({ state: 'visible', timeout: 15000 });
  const iframe = drawer.locator('iframe');
  await iframe.waitFor({ state: 'visible', timeout: 15000 });
  await page.frameLocator('.modbus-controller-drawer iframe').getByRole('heading', { name: 'Digital Twin Modbus Controller' }).waitFor({ timeout: 15000 });
  const iframeSrc = await iframe.getAttribute('src');
  if (!iframeSrc?.includes('embedded=1')) throw new Error(`Controller iframe is not using embedded mode: ${iframeSrc}`);

  await drawer.getByRole('button', { name: 'Hide Modbus Controller' }).click();
  if (!(await drawer.evaluate((element) => element.classList.contains('closed')))) throw new Error('Controller drawer did not close.');
  if (await iframe.count() !== 1) throw new Error('Controller iframe was unmounted while hidden; BLE sessions would be lost.');

  await page.getByRole('button', { name: 'Show Modbus Controller' }).click();
  await drawer.waitFor({ state: 'visible' });
  if ((await iframe.getAttribute('src')) !== iframeSrc) throw new Error('Controller iframe was recreated after reopening.');

  await page.getByTitle('Warehouse dashboard').click();
  if (!(await page.getByRole('button', { name: 'Hide Modbus Controller' }).last().isVisible())) throw new Error('Controller drawer is not accessible from Warehouse.');

  await page.setViewportSize({ width: 480, height: 800 });
  const drawerBox = await drawer.boundingBox();
  if (!drawerBox || drawerBox.x < -1 || drawerBox.width > 481) throw new Error(`Controller drawer is not responsive at mobile width: ${JSON.stringify(drawerBox)}`);

  const health = await fetch('http://127.0.0.1:8765/health').then((response) => response.json());
  if (health.service !== 'visual-modbus-robot-controller') throw new Error(`Unexpected controller health: ${JSON.stringify(health)}`);
  if (!String(await page.locator('.statusbar').innerText()).includes('Modbus Controller ready')) throw new Error('Main dashboard did not report that the controller is ready.');

  console.log('Modbus Controller launcher regression passed: persistent responsive drawer opened in Workspace and Warehouse.');
} finally {
  await browser?.close();
  if (!vite.killed) vite.kill('SIGTERM');
}
