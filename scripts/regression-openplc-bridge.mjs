import net from 'node:net';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const vitePort = Number(process.env.OPENPLC_TEST_VITE_PORT ?? 5217);
const openPlcPort = Number(process.env.OPENPLC_TEST_MODBUS_PORT ?? 15020);
const values = [1.25, -0.5, 0.75, -1.1, 0.2, 2.4];
const writes = [];

const floatWords = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatBE(value, 0);
  return [buffer.readUInt16BE(0), buffer.readUInt16BE(2)];
};
const int16Word = (value) => (Math.round(value * 10000) & 0xffff);

const modbusServer = net.createServer((socket) => {
  socket.on('data', (request) => {
    if (request.length < 8) return;
    const transactionId = request.readUInt16BE(0);
    const unitId = request[6];
    const functionCode = request[7];
    if (functionCode === 3) {
      const address = request.readUInt16BE(8);
      const quantity = request.readUInt16BE(10);
      const profile = [1, 1, 3, 2400, 0, 0, 0, 0, 0, 0, ...values.map(int16Word)];
      const words = (address === 90 ? profile : quantity === 6 ? values.map(int16Word) : values.flatMap(floatWords)).slice(0, quantity);
      while (words.length < quantity) words.push(0);
      const pdu = Buffer.from([3, words.length * 2, ...words.flatMap((word) => [word >> 8, word & 0xff])]);
      socket.write(Buffer.concat([Buffer.from([transactionId >> 8, transactionId & 0xff, 0, 0, 0, pdu.length + 1, unitId]), pdu]));
      return;
    }
    if (functionCode === 6 || functionCode === 16) {
      const address = request.readUInt16BE(8);
      const quantity = functionCode === 6 ? 1 : request.readUInt16BE(10);
      const words = functionCode === 6 ? [request.readUInt16BE(10)] : Array.from({ length: quantity }, (_, index) => request.readUInt16BE(13 + index * 2));
      writes.push({ functionCode, address, words });
      const pdu = Buffer.from([functionCode, address >> 8, address & 0xff, quantity >> 8, quantity & 0xff]);
      socket.write(Buffer.concat([Buffer.from([transactionId >> 8, transactionId & 0xff, 0, 0, 0, pdu.length + 1, unitId]), pdu]));
    }
  });
});

await new Promise((resolveListen, rejectListen) => {
  modbusServer.once('error', rejectListen);
  modbusServer.listen(openPlcPort, '127.0.0.1', resolveListen);
});

const viteBin = resolve('node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { cwd: resolve('.'), stdio: 'inherit', shell: false });
const waitForServer = async (url) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    try { if ((await fetch(url)).ok) return; } catch { /* Vite is starting. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 180));
  }
  throw new Error(`Timed out waiting for ${url}`);
};

let browser;
try {
  await waitForServer(`http://127.0.0.1:${vitePort}`);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(`http://127.0.0.1:${vitePort}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Industrial Cell/ }).click();
  await page.getByRole('button', { name: /Industrial Gantry Robot/ }).click();
  await page.getByRole('button', { name: /Digital Twin Scenario/ }).click();
  const dashboard = page.locator('.plc-dashboard');
  await dashboard.waitFor();
  const disconnect = dashboard.getByRole('button', { name: /Disconnect Client/ });
  if (await disconnect.isEnabled()) await disconnect.click();

  const connector = dashboard.locator('.openplc-connector');
  await connector.locator('label').filter({ hasText: 'IP / host' }).locator('input').fill('127.0.0.1');
  await connector.locator('label').filter({ hasText: 'Port' }).locator('input').fill(String(openPlcPort));
  await connector.locator('label').filter({ hasText: 'Unit ID' }).locator('input').fill('1');
  await connector.locator('label').filter({ hasText: 'HR start' }).locator('input').fill('100');
  await connector.locator('label').filter({ hasText: 'Data' }).locator('select').selectOption('float32-be');
  await dashboard.getByRole('button', { name: 'Connect OpenPLC' }).click();
  await connector.getByText('ONLINE', { exact: true }).waitFor({ timeout: 15000 });
  await page.waitForFunction(() => /RX [1-9]\d*/.test(document.querySelector('.openplc-connector code')?.textContent ?? ''), undefined, { timeout: 15000 });

  const controls = dashboard.locator('.plc-register-control input');
  const physicalJ1 = Number(await controls.nth(0).inputValue());
  const twinJ1 = Number(await controls.nth(6).inputValue());
  if (Math.abs(physicalJ1 - values[0]) > 0.001 || Math.abs(twinJ1 - values[0]) > 0.001) throw new Error(`OpenPLC FC03 value mismatch: physical=${physicalJ1}, twin=${twinJ1}`);

  if (await controls.nth(0).isEnabled()) throw new Error('OpenPLC-owned joint control must be read-only.');
  await dashboard.getByRole('button', { name: /Local Manual/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.plc-register-control input:not([disabled])').length >= 6, undefined, { timeout: 10000 });
  if (await connector.getByText('ONLINE', { exact: true }).isVisible()) throw new Error('Local Manual did not disconnect OpenPLC authority.');
  await controls.nth(0).fill('2.1');
  if (Math.abs(Number(await controls.nth(0).inputValue()) - 2.1) > 0.011) throw new Error('Local Manual did not accept the J1 command.');

  await connector.getByRole('button', { name: 'Auto Detect Map' }).click();
  await connector.getByText(/Detected %QW90\.\.105/).waitFor({ timeout: 10000 });
  await dashboard.getByRole('button', { name: 'Connect OpenPLC' }).click();
  await page.waitForFunction(
    (expected) => {
      const inputs = document.querySelectorAll('.plc-dashboard .plc-register-control input');
      return /6 HR/.test(document.querySelector('.openplc-connector code')?.textContent ?? '') && inputs.length > 1 && Math.abs(Number(inputs[1].value) - expected) < 0.00011;
    },
    values[1],
    { timeout: 15000 },
  );
  const int16J2 = Number(await controls.nth(1).inputValue());
  if (Math.abs(int16J2 - values[1]) > 0.00011) throw new Error(`OpenPLC INT16 decode mismatch: ${int16J2}`);
  if (await controls.nth(1).isEnabled()) throw new Error('INT16 OpenPLC joint control must remain read-only.');

  console.log('OpenPLC bridge regression passed: FLOAT32/INT16 telemetry reached the twin and Local Manual transferred write authority safely.');
} finally {
  await browser?.close();
  if (!vite.killed) vite.kill('SIGTERM');
  await new Promise((resolveClose) => modbusServer.close(resolveClose));
}
