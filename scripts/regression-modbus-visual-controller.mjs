import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve('.');
const port = Number(process.env.MODBUS_VISUAL_TEST_PORT ?? 8776);
const controllerScript = resolve('scripts', 'modbus_visual_controller.mjs');

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

if (!existsSync(controllerScript)) throw new Error('Missing scripts/modbus_visual_controller.mjs.');

const server = spawn(process.execPath, [controllerScript, `--port=${port}`], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});
const logs = [];
server.stdout.on('data', (chunk) => logs.push(String(chunk)));
server.stderr.on('data', (chunk) => logs.push(String(chunk)));

try {
  await waitForServer(`http://127.0.0.1:${port}/state`);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const normalizeUuid = (uuid) => {
        if (typeof uuid === 'number') return `0000${uuid.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
        const value = String(uuid).toLowerCase();
        if (/^0x[0-9a-f]{4}$/.test(value)) return `0000${value.slice(2)}-0000-1000-8000-00805f9b34fb`;
        return value;
      };
      const movementService = 'f000aa80-0451-4000-b000-000000000000';
      const movementData = 'f000aa81-0451-4000-b000-000000000000';
      const movementConfig = 'f000aa82-0451-4000-b000-000000000000';
      const movementPeriod = 'f000aa83-0451-4000-b000-000000000000';
      const legacyService = 'f000aa10-0451-4000-b000-000000000000';
      const legacyData = 'f000aa11-0451-4000-b000-000000000000';
      const legacyConfig = 'f000aa12-0451-4000-b000-000000000000';
      const legacyPeriod = 'f000aa13-0451-4000-b000-000000000000';
      const keyfobService = normalizeUuid(0xffa0);
      const keyfobConfig = normalizeUuid(0xffa1);
      const keyfobRange = normalizeUuid(0xffa2);
      const keyfobAxes = { x: normalizeUuid(0xffa3), y: normalizeUuid(0xffa4), z: normalizeUuid(0xffa5) };
      const keyfobPeriod = normalizeUuid(0xffa6);
      const calls = [];
      class FakeCharacteristic extends EventTarget {
        constructor(uuid) {
          super();
          this.uuid = uuid;
          this.value = new DataView(new Uint8Array([0]).buffer);
        }
        async startNotifications() {
          calls.push(['startNotifications', this.uuid]);
          return this;
        }
        async stopNotifications() {
          calls.push(['stopNotifications', this.uuid]);
        }
        async writeValue(value) {
          calls.push(['writeValue', this.uuid, Array.from(new Uint8Array(value.buffer ?? value))]);
          if (window.__failKeyfobOptionalWrites && (this.uuid === keyfobRange || this.uuid === keyfobPeriod)) throw new Error('optional-keyfob-write-failed');
        }
        async readValue() {
          calls.push(['readValue', this.uuid]);
          return this.value;
        }
      }
      const movementCharacteristics = {
        [movementData]: new FakeCharacteristic(movementData),
        [movementConfig]: new FakeCharacteristic(movementConfig),
        [movementPeriod]: new FakeCharacteristic(movementPeriod),
      };
      const legacyCharacteristics = {
        [legacyData]: new FakeCharacteristic(legacyData),
        [legacyConfig]: new FakeCharacteristic(legacyConfig),
        [legacyPeriod]: new FakeCharacteristic(legacyPeriod),
      };
      const keyfobCharacteristics = {
        [keyfobConfig]: new FakeCharacteristic(keyfobConfig),
        [keyfobRange]: new FakeCharacteristic(keyfobRange),
        [keyfobAxes.x]: new FakeCharacteristic(keyfobAxes.x),
        [keyfobAxes.y]: new FakeCharacteristic(keyfobAxes.y),
        [keyfobAxes.z]: new FakeCharacteristic(keyfobAxes.z),
        [keyfobPeriod]: new FakeCharacteristic(keyfobPeriod),
      };
      const services = new Map([
        [movementService, Object.values(movementCharacteristics)],
        [legacyService, Object.values(legacyCharacteristics)],
        [keyfobService, Object.values(keyfobCharacteristics)],
      ]);
      const device = new EventTarget();
      device.name = 'TI BLE test device';
      device.id = 'fake-ti-ble';
      device.gatt = {
        async connect() {
          calls.push(['gatt.connect']);
          return {
            async getPrimaryService(uuid) {
              calls.push(['getPrimaryService', uuid]);
              const characteristics = services.get(normalizeUuid(uuid));
              if (!characteristics) throw new Error('unexpected-service');
              return {
                async getCharacteristics() {
                  calls.push(['getCharacteristics']);
                  return characteristics;
                },
              };
            },
          };
        },
        disconnect() {
          calls.push(['gatt.disconnect']);
        },
      };
      Object.defineProperty(navigator, 'bluetooth', {
        configurable: true,
        value: {
          async requestDevice(options) {
            calls.push(['requestDevice', options]);
            return device;
          },
        },
      });
      window.__bleCalls = calls;
      window.__emitBleMovement = (values) => {
        const data = new Uint8Array(values);
        movementCharacteristics[movementData].value = new DataView(data.buffer);
        movementCharacteristics[movementData].dispatchEvent(new Event('characteristicvaluechanged'));
      };
      window.__emitBleLegacyAccel = (values) => {
        const data = new Uint8Array(values);
        legacyCharacteristics[legacyData].value = new DataView(data.buffer);
        legacyCharacteristics[legacyData].dispatchEvent(new Event('characteristicvaluechanged'));
      };
      window.__emitBleKeyfob = (axis, value) => {
        const characteristic = keyfobCharacteristics[keyfobAxes[axis]];
        const data = new Uint8Array([value & 0xff]);
        characteristic.value = new DataView(data.buffer);
        characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
      };
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('Digital Twin Modbus Controller'), undefined, { timeout: 30000 });
    await page.waitForFunction(() => document.body.innerText.includes('not connected') && document.body.innerText.includes('No packets before manual connection'), undefined, { timeout: 30000 });
    await page.waitForFunction(
      () =>
        document.body.innerText.includes('BLE TI SensorTag / Keyfob') &&
        document.body.innerText.includes('Auto detect TI profile') &&
        document.body.innerText.includes('CC2541 SensorTag Accelerometer') &&
        document.body.innerText.includes('CC2541 Keyfob Accelerometer') &&
        document.body.innerText.includes('Connect BLE Device') &&
        document.body.innerText.includes('Disconnect Active BLE') &&
        document.body.innerText.includes('Disconnect All BLE') &&
        document.body.innerText.includes('Disconnect Platform') &&
        document.body.innerText.includes('X Scale') &&
        document.body.innerText.includes('Y Scale') &&
        document.body.innerText.includes('Z Scale') &&
        document.body.innerText.includes('Automatic Calibration') &&
        document.body.innerText.includes('Calibrate Selected HR') &&
        document.body.innerText.includes('Auto Calibrate All Joints') &&
        document.body.innerText.includes('x3.0') &&
        document.body.innerText.includes('HR 40101 J1') &&
        document.body.innerText.includes('BLE idle'),
      undefined,
      { timeout: 30000 },
    );
    const defaultBleGain = await page.locator('#ble-gain-x').inputValue();
    if (defaultBleGain !== '3.0') throw new Error(`BLE X gain should default to 3.0, got ${defaultBleGain}.`);
    await page.locator('#ble-gain-x').fill('4.5');
    await page.waitForFunction(() => document.body.innerText.includes('x4.5'), undefined, { timeout: 30000 });
    const storedBleGain = await page.evaluate(() => JSON.parse(localStorage.getItem('assetForge.bleAxisGains') || '{}'));
    if (storedBleGain.x !== 4.5 || storedBleGain.y !== 3 || storedBleGain.z !== 3) throw new Error(`BLE per-axis gain was not persisted. Stored: ${JSON.stringify(storedBleGain)}`);
    const syncedRange = await page.locator('#ble-gain-range-x').inputValue();
    if (syncedRange !== '4.5') throw new Error(`BLE X gain slider was not synced. Value: ${syncedRange}`);
    await page.locator('#ble-gain-x').fill('3.0');
    await page.locator('#ble-gain-y').fill('2.0');
    await page.locator('[data-ble-map="j1:active:x"]').click();
    await page.locator('[data-ble-map="j1:active:y"]').click();
    const storedBleMap = await page.evaluate(() => JSON.parse(localStorage.getItem('assetForge.bleAxisMap') || '{}'));
    if (storedBleMap.j1?.source !== 'active' || !Array.isArray(storedBleMap.j1?.axes) || storedBleMap.j1.axes.join(',') !== 'x,y') {
      throw new Error(`BLE multi-axis mapping was not persisted for HR 40101/J1: ${JSON.stringify(storedBleMap.j1)}`);
    }
    await page.waitForFunction(
      (expectedPort) =>
        document.body.innerText.includes('Controller IP') &&
        document.body.innerText.includes('Controller Port') &&
        document.body.innerText.includes(`127.0.0.1:${expectedPort}`) &&
        document.body.innerText.includes('/state') &&
        document.body.innerText.includes('/write'),
      String(port),
      { timeout: 30000 },
    );
    await page.locator('#controller-ip').fill('127.0.0.1');
    await page.locator('#controller-port').fill(String(port));
    await page.getByRole('button', { name: /^Connect$/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('HR 40103') && document.body.innerText.includes('Live Modbus TCP'), undefined, { timeout: 30000 });
    await page.waitForFunction(() => /connected - (manual|cycle) live/.test(document.body.innerText), undefined, { timeout: 30000 });
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
    if (!health.connectedClients?.length) throw new Error('Visual controller did not register a connected client session.');
    await fetch(`http://127.0.0.1:${port}/state`, {
      headers: {
        'X-Asset-Forge-Client': 'platform-3d',
        'X-Asset-Forge-Session': 'regression-platform',
      },
    });
    await page.waitForFunction(() => document.body.innerText.includes('Platform RX active'), undefined, { timeout: 30000 });
    await page.getByRole('button', { name: /^Disconnect Platform$/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('platform disconnected') && document.body.innerText.includes('Platform RX off'), undefined, { timeout: 30000 });
    const disconnectedHealth = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
    if (disconnectedHealth.connectedClients?.length) throw new Error(`Visual controller did not disconnect the platform session: ${JSON.stringify(disconnectedHealth.connectedClients)}`);
    await page.getByRole('button', { name: /^Connect$/ }).click();
    await page.waitForFunction(() => /connected - (manual|cycle) live/.test(document.body.innerText), undefined, { timeout: 30000 });
    const reconnectedHealth = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
    const browserSessionId = reconnectedHealth.connectedClients?.[0]?.id;
    if (!browserSessionId) throw new Error(`Visual controller did not reconnect a browser session: ${JSON.stringify(reconnectedHealth.connectedClients)}`);
    await fetch(`http://127.0.0.1:${port}/client-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: browserSessionId, status: 'disconnected', endpoint: `http://127.0.0.1:${port}` }),
    });
    await page.waitForFunction(() => document.body.innerText.includes('platform disconnected by 3D'), undefined, { timeout: 30000 });
    await page.getByRole('button', { name: /^Connect$/ }).click();
    await page.waitForFunction(() => /connected - (manual|cycle) live/.test(document.body.innerText), undefined, { timeout: 30000 });
    await page.getByRole('button', { name: /^Connect BLE Device$/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('BLE starting'), undefined, { timeout: 30000 });
    const bleCalls = await page.evaluate(() => window.__bleCalls);
    const notifyIndex = bleCalls.findIndex((call) => call[0] === 'startNotifications' && call[1] === 'f000aa81-0451-4000-b000-000000000000');
    const periodIndex = bleCalls.findIndex((call) => call[0] === 'writeValue' && call[1] === 'f000aa83-0451-4000-b000-000000000000');
    const configIndex = bleCalls.findIndex((call) => call[0] === 'writeValue' && call[1] === 'f000aa82-0451-4000-b000-000000000000');
    if (!(notifyIndex >= 0 && periodIndex > notifyIndex && configIndex > periodIndex)) {
      throw new Error(`BLE GATT sequence is wrong: ${JSON.stringify(bleCalls)}`);
    }
    const configWrite = bleCalls[configIndex];
    if (JSON.stringify(configWrite[2]) !== JSON.stringify([0x7f, 0x00])) throw new Error(`BLE movement config must use 0x7f 0x00. Calls: ${JSON.stringify(bleCalls)}`);
    await page.evaluate(() => window.__emitBleMovement([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    await page.waitForTimeout(130);
    await page.locator('#ble-calibration-joint').selectOption('j2');
    await page.waitForFunction(() => document.body.innerText.includes('hombro delante/atras') && document.body.innerText.includes('delante'), undefined, { timeout: 30000 });
    await page.getByRole('button', { name: /^Calibrate Selected HR$/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Prepare HR 40103') && document.body.innerText.includes('delante'), undefined, { timeout: 30000 });
    for (let index = 0; index < 36; index += 1) {
      const rawY = Math.round((index / 35) * 8192);
      await page.evaluate((value) => {
        window.__emitBleMovement([0, 0, 0, 0, 0, 0, 0, 0, value & 0xff, (value >> 8) & 0xff, 0, 0]);
      }, rawY);
      await page.waitForTimeout(120);
    }
    await page.waitForFunction(() => document.body.innerText.includes('Saved HR 40103 J2'), undefined, { timeout: 30000 });
    const calibrationProfile = await page.evaluate(() => JSON.parse(localStorage.getItem('assetForge.bleCalibrationProfile') || '{}'));
    if (!calibrationProfile.results?.some((result) => result.jointId === 'j2' && result.axes.includes('y'))) throw new Error(`BLE calibration profile did not save J2/Y: ${JSON.stringify(calibrationProfile)}`);
    const calibratedSigns = await page.evaluate(() => JSON.parse(localStorage.getItem('assetForge.bleAxisSigns') || '{}'));
    if (calibratedSigns.j2?.y !== 1) throw new Error(`BLE calibration did not persist J2/Y polarity: ${JSON.stringify(calibratedSigns.j2)}`);
    const calibratedGains = await page.evaluate(() => JSON.parse(localStorage.getItem('assetForge.bleAxisGains') || '{}'));
    if (!(calibratedGains.y >= 0.1 && calibratedGains.y <= 10)) throw new Error(`BLE calibration gain out of range: ${JSON.stringify(calibratedGains)}`);
    await page.evaluate(() => window.__emitBleMovement([0, 0, 0, 0, 0, 0, 0, 32, 0, 32, 0, 0]));
    await page.waitForTimeout(600);
    const bleDriven = await fetch(`http://127.0.0.1:${port}/state`).then((response) => response.json());
    const bleJ1 = bleDriven.registers.find((register) => register.displayAddress === '40101');
    if (!bleJ1 || Math.abs(bleJ1.value) < 0.01) throw new Error(`BLE X+Y mapping did not update HR 40101/J1. Value: ${bleJ1?.value}`);

    const before = await fetch(`http://127.0.0.1:${port}/state`).then((response) => response.json());
    const slider = page.locator('[data-slider="j2"]');
    await slider.evaluate((input) => {
      input.value = '1.25';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(400);
    const after = await fetch(`http://127.0.0.1:${port}/state`).then((response) => response.json());
    const j2 = after.registers.find((register) => register.displayAddress === '40103');
    if (!j2 || Math.abs(j2.value - 1.25) > 0.0001) throw new Error(`Visual slider did not update HR 40103. Value: ${j2?.value}`);
    if (before.sequence >= after.sequence) throw new Error('Controller sequence did not advance.');
    if (!after.modbusPackets?.[1]?.hex || !after.modbusPackets[1].decoded.includes('0x')) throw new Error('Controller did not expose live Modbus packet hex.');

    await page.getByText('J3+').click();
    await page.waitForTimeout(300);
    const nudged = await fetch(`http://127.0.0.1:${port}/state`).then((response) => response.json());
    const j3 = nudged.registers.find((register) => register.displayAddress === '40105');
    if (!j3 || Math.abs(j3.value) < 0.01) throw new Error('Gamepad button J3+ did not nudge HR 40105.');
    await page.getByRole('button', { name: /^Disconnect Active BLE$/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('BLE idle') && document.body.innerText.includes('no device'), undefined, { timeout: 30000 });

    await page.locator('#ble-profile').selectOption('cc2541-sensortag');
    await page.getByRole('button', { name: /^Connect BLE Device$/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('CC2541 SensorTag Accelerometer') && document.body.innerText.includes('BLE starting'), undefined, { timeout: 30000 });
    const legacyBleCalls = await page.evaluate(() => window.__bleCalls);
    const legacyNotifyIndex = legacyBleCalls.findIndex((call) => call[0] === 'startNotifications' && call[1] === 'f000aa11-0451-4000-b000-000000000000');
    const legacyPeriodIndex = legacyBleCalls.findIndex((call) => call[0] === 'writeValue' && call[1] === 'f000aa13-0451-4000-b000-000000000000');
    const legacyConfigIndex = legacyBleCalls.findIndex((call) => call[0] === 'writeValue' && call[1] === 'f000aa12-0451-4000-b000-000000000000');
    if (!(legacyNotifyIndex >= 0 && legacyPeriodIndex > legacyNotifyIndex && legacyConfigIndex > legacyPeriodIndex)) {
      throw new Error(`CC2541 SensorTag GATT sequence is wrong: ${JSON.stringify(legacyBleCalls)}`);
    }
    if (JSON.stringify(legacyBleCalls[legacyConfigIndex][2]) !== JSON.stringify([0x01])) throw new Error(`CC2541 SensorTag accelerometer config must use 0x01. Calls: ${JSON.stringify(legacyBleCalls)}`);
    await page.evaluate(() => window.__emitBleLegacyAccel([0, 0, 64]));
    await page.waitForFunction(() => document.body.innerText.includes('BLE live'), undefined, { timeout: 30000 });
    await page.getByRole('button', { name: /^Disconnect Active BLE$/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('BLE idle') && document.body.innerText.includes('no device'), undefined, { timeout: 30000 });

    await page.locator('#ble-profile').selectOption('cc2541-keyfob');
    await page.evaluate(() => {
      window.__failKeyfobOptionalWrites = true;
    });
    await page.getByRole('button', { name: /^Connect BLE Device$/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('CC2541 Keyfob Accelerometer') && document.body.innerText.includes('BLE starting'), undefined, { timeout: 30000 });
    const keyfobBleCalls = await page.evaluate(() => window.__bleCalls);
    const keyfobNotifyIndex = keyfobBleCalls.findIndex((call) => call[0] === 'startNotifications' && call[1] === '0000ffa3-0000-1000-8000-00805f9b34fb');
    const keyfobConfigIndex = keyfobBleCalls.findIndex((call) => call[0] === 'writeValue' && call[1] === '0000ffa1-0000-1000-8000-00805f9b34fb');
    if (!(keyfobNotifyIndex >= 0 && keyfobConfigIndex > keyfobNotifyIndex)) {
      throw new Error(`CC2541 Keyfob GATT sequence is wrong: ${JSON.stringify(keyfobBleCalls)}`);
    }
    if (JSON.stringify(keyfobBleCalls[keyfobConfigIndex][2]) !== JSON.stringify([0x01])) throw new Error(`CC2541 Keyfob accelerometer enable must use 0x01. Calls: ${JSON.stringify(keyfobBleCalls)}`);
    await page.evaluate(() => {
      window.__emitBleKeyfob('x', 32);
      window.__emitBleKeyfob('y', 16);
      window.__emitBleKeyfob('z', 64);
    });
    await page.waitForFunction(() => document.body.innerText.includes('BLE live'), undefined, { timeout: 30000 });
    const keyfobStatus = await page.locator('#ble-status').innerText();
    if (keyfobStatus !== 'BLE live') throw new Error(`Keyfob with optional GATT write failures should stay live, got ${keyfobStatus}.`);
    await page.getByRole('button', { name: /^Disconnect Active BLE$/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('BLE idle') && document.body.innerText.includes('no device'), undefined, { timeout: 30000 });

    await page.locator('#ble-profile').selectOption('cc2650');
    await page.getByRole('button', { name: /^Connect BLE Device$/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('CC2650 SensorTag Movement') && document.body.innerText.includes('BLE starting'), undefined, { timeout: 30000 });
    await page.evaluate(() => window.__emitBleMovement([0, 0, 0, 0, 0, 0, 0, 24, 0, 0, 0, 0]));
    await page.waitForFunction(() => document.body.innerText.includes('BLE live'), undefined, { timeout: 30000 });
    await page.locator('#ble-profile').selectOption('cc2541-sensortag');
    await page.getByRole('button', { name: /^Connect BLE Device$/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('CC2541 SensorTag Accelerometer') && document.body.innerText.includes('BLE starting'), undefined, { timeout: 30000 });
    await page.evaluate(() => window.__emitBleLegacyAccel([32, 0, 0]));
    await page.waitForFunction(() => document.querySelectorAll('.ble-device-card').length === 2 && document.body.innerText.includes('Driving Robot'), undefined, { timeout: 30000 });
    const multiDeviceCards = await page.locator('.ble-device-card').allInnerTexts();
    if (!multiDeviceCards.some((text) => text.includes('CC2650 SensorTag Movement')) || !multiDeviceCards.some((text) => text.includes('CC2541 SensorTag Accelerometer'))) {
      throw new Error(`BLE multi-device list did not show separate device coordinates: ${JSON.stringify(multiDeviceCards)}`);
    }
    await page.waitForFunction(() => document.body.innerText.includes('X1') && document.body.innerText.includes('X2') && document.body.innerText.includes('Y2'), undefined, { timeout: 30000 });
    await page.locator('[data-ble-map="j1:1:x"]').click();
    await page.locator('[data-ble-map="j2:2:x"]').click();
    const multiSourceMap = await page.evaluate(() => JSON.parse(localStorage.getItem('assetForge.bleAxisMap') || '{}'));
    if (multiSourceMap.j1?.source !== '1' || multiSourceMap.j1?.axes?.join(',') !== 'x' || multiSourceMap.j2?.source !== '2' || multiSourceMap.j2?.axes?.join(',') !== 'x') {
      throw new Error(`BLE per-device HR mapping did not persist X1/X2 sources: ${JSON.stringify(multiSourceMap)}`);
    }
    for (let index = 0; index < 4; index += 1) {
      await page.evaluate((step) => {
        const movementRaw = 24 + step * 16;
        const legacyRaw = 32 + step * 10;
        window.__emitBleMovement([0, 0, 0, 0, 0, 0, movementRaw & 0xff, (movementRaw >> 8) & 0xff, 0, 0, 0, 0]);
        window.__emitBleLegacyAccel([legacyRaw, 0, 0]);
      }, index);
      await page.waitForTimeout(130);
    }
    await page.waitForTimeout(800);
    const multiSourceState = await fetch(`http://127.0.0.1:${port}/state`).then((response) => response.json());
    const multiJ1 = multiSourceState.registers.find((register) => register.displayAddress === '40101');
    const multiJ2 = multiSourceState.registers.find((register) => register.displayAddress === '40103');
    if (!multiJ1 || Math.abs(multiJ1.value) < 0.01 || !multiJ2 || Math.abs(multiJ2.value) < 0.01) {
      const visibleMap = await page.locator('#ble-map').innerText();
      throw new Error(`BLE X1/X2 mapping did not drive separate HR registers: J1=${multiJ1?.value}, J2=${multiJ2?.value}, map=${JSON.stringify(multiSourceMap)}, cards=${JSON.stringify(multiDeviceCards)}, visibleMap=${JSON.stringify(visibleMap)}`);
    }
    await page.locator('.ble-device-card').filter({ hasText: 'CC2650 SensorTag Movement' }).getByRole('button', { name: /^Drive Robot$/ }).click();
    await page.waitForFunction(() => document.getElementById('ble-device')?.textContent?.includes('CC2650 SensorTag Movement'), undefined, { timeout: 30000 });
    await page.getByRole('button', { name: /^Disconnect All BLE$/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.ble-device-card').length === 0 && document.body.innerText.includes('No BLE devices connected.'), undefined, { timeout: 30000 });

    console.log('Visual Modbus controller regression passed.');
    await context.close();
  } finally {
    await browser.close();
  }
} catch (error) {
  if (logs.length) console.error(logs.join(''));
  throw error;
} finally {
  server.kill();
}
