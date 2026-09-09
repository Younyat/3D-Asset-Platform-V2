import http from 'node:http';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseUrl } from 'node:url';

const DEFAULT_JOINTS = [
  { id: 'j1', name: 'J1 - Giro base', lower: -3.14, upper: 3.14, address: 100, displayAddress: '40101' },
  { id: 'j2', name: 'J2 - Hombro adelante/atras', lower: -1.75, upper: 1.75, address: 102, displayAddress: '40103' },
  { id: 'j3', name: 'J3 - Elevacion arriba/abajo', lower: -2.2, upper: 2.2, address: 104, displayAddress: '40105' },
  { id: 'j4', name: 'J4 - Muneca arriba/abajo', lower: -3.14, upper: 3.14, address: 106, displayAddress: '40107' },
  { id: 'j5', name: 'J5 - Muneca derecha/izquierda', lower: -3.14, upper: 3.14, address: 108, displayAddress: '40109' },
  { id: 'j6', name: 'J6 - Giro rotatorio herramienta', lower: -3.14, upper: 3.14, address: 110, displayAddress: '40111' },
];

const JOINT_DIRECTION_GUIDES = {
  j1: { positive: 'derecha', negative: 'izquierda', instruction: 'mueve el SensorTag hacia la derecha del robot real', intent: 'base derecha/izquierda' },
  j2: { positive: 'delante', negative: 'atras', instruction: 'mueve el SensorTag hacia delante del robot real', intent: 'hombro delante/atras' },
  j3: { positive: 'arriba', negative: 'abajo', instruction: 'mueve el SensorTag hacia arriba', intent: 'elevacion arriba/abajo' },
  j4: { positive: 'arriba', negative: 'abajo', instruction: 'mueve el SensorTag hacia arriba; valores altos suben la muneca', intent: 'muneca arriba/abajo' },
  j5: { positive: 'derecha', negative: 'izquierda', instruction: 'mueve el SensorTag hacia la derecha de la muneca', intent: 'muneca derecha/izquierda' },
  j6: { positive: 'giro horario', negative: 'giro antihorario', instruction: 'gira el SensorTag como giraria la herramienta extrema', intent: 'giro rotatorio de herramienta' },
};

const clamp = (value, lower, upper) => Math.max(lower, Math.min(upper, value));

const encodeF32Words = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatBE(Number(value), 0);
  return [buffer.readUInt16BE(0), buffer.readUInt16BE(2)];
};

const wordsToHex = (words) => words.map((word) => `0x${word.toString(16).padStart(4, '0').toUpperCase()}`).join(' ');

const localDisplayHost = (host) => (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host);
const cleanRemoteAddress = (address) => String(address ?? '').replace(/^::ffff:/, '') || 'unknown';
const browserInfoHeaderName = ['user', ['a', 'g', 'e', 'n', 't'].join('')].join('-');

const modbusTcpHex = (transactionId, unitId, pdu) => {
  const length = pdu.length + 1;
  const frame = [
    (transactionId >> 8) & 0xff,
    transactionId & 0xff,
    0,
    0,
    (length >> 8) & 0xff,
    length & 0xff,
    unitId,
    ...pdu,
  ];
  return frame.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
};

const readJsonBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });

const execFileAsync = (file, args) =>
  new Promise((resolveExec, rejectExec) => {
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        rejectExec(error);
        return;
      }
      resolveExec({ stdout, stderr });
    });
  });

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const listeningPidsForPort = async (port) => {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp']);
    return [
      ...new Set(
        stdout
          .split(/\r?\n/)
          .filter((line) => {
            const parts = line.trim().split(/\s+/);
            const local = parts[1] ?? '';
            const state = parts.at(-2) ?? '';
            return local.endsWith(`:${port}`) && /LISTENING|ESCUCHANDO/i.test(state);
          })
          .map((line) => Number(line.trim().split(/\s+/).at(-1)))
          .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid),
      ),
    ];
  }

  try {
    const { stdout } = await execFileAsync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN']);
    return stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
};

const stopListenersOnPort = async (port) => {
  const pids = await listeningPidsForPort(port);
  for (const pid of pids) {
    if (process.platform === 'win32') {
      try {
        process.kill(pid);
      } catch {
        // Fallback below handles stubborn or already-exited processes.
      }
      await sleep(250);
      const stillListening = (await listeningPidsForPort(port)).includes(pid);
      if (stillListening) await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F']).catch(() => undefined);
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // The process may already have exited.
      }
    }
  }
  if (pids.length) await sleep(700);
  return pids;
};

class VisualModbusState {
  constructor() {
    this.startedAt = Date.now();
    this.sequence = 0;
    this.cycleEnabled = false;
    this.unitId = 1;
    this.clients = new Map();
    this.blockedClients = new Set();
    this.stateReaders = new Map();
    this.values = Object.fromEntries(DEFAULT_JOINTS.map((joint) => [joint.id, 0]));
  }

  registerClient(session, context = {}) {
    const id = String(session.id ?? `${cleanRemoteAddress(context.clientIp)}:${context.clientPort ?? 'unknown'}`);
    const status = String(session.status ?? 'connected');
    if (status === 'disconnected') {
      this.clients.delete(id);
      this.blockedClients.add(id);
      return { id, accepted: false };
    }
    if (session.manualConnect === true) {
      this.blockedClients.delete(id);
    }
    if (this.blockedClients.has(id)) {
      this.clients.delete(id);
      return { id, accepted: false };
    }
    this.clients.set(id, {
      id,
      ip: cleanRemoteAddress(context.clientIp),
      port: context.clientPort,
      endpoint: session.endpoint,
      browserInfo: context.browserInfo,
      connectedAtUtc: this.clients.get(id)?.connectedAtUtc ?? new Date().toISOString(),
      lastSeenUtc: new Date().toISOString(),
    });
    return { id, accepted: true };
  }

  disconnectClient(id) {
    const cleanId = String(id ?? '').trim();
    if (!cleanId) return { id: '', accepted: false };
    this.clients.delete(cleanId);
    this.blockedClients.add(cleanId);
    return { id: cleanId, accepted: false };
  }

  isClientAccepted(id) {
    const cleanId = String(id ?? '').trim();
    return cleanId ? !this.blockedClients.has(cleanId) : true;
  }

  activeClients() {
    const now = Date.now();
    const active = [];
    for (const [id, client] of this.clients.entries()) {
      const lastSeenMs = Date.parse(client.lastSeenUtc);
      if (Number.isFinite(lastSeenMs) && now - lastSeenMs <= 12000) {
        active.push(client);
      } else {
        this.clients.delete(id);
      }
    }
    return active;
  }

  registerStateReader(context = {}) {
    if (context.readerKind !== 'platform-3d') return;
    const id = String(context.readerId ?? `${cleanRemoteAddress(context.clientIp)}:${context.clientPort ?? 'unknown'}`);
    this.stateReaders.set(id, {
      id,
      kind: context.readerKind,
      ip: cleanRemoteAddress(context.clientIp),
      port: context.clientPort,
      connectedAtUtc: this.stateReaders.get(id)?.connectedAtUtc ?? new Date().toISOString(),
      lastSeenUtc: new Date().toISOString(),
    });
  }

  activeStateReaders() {
    const now = Date.now();
    const active = [];
    for (const [id, reader] of this.stateReaders.entries()) {
      const lastSeenMs = Date.parse(reader.lastSeenUtc);
      if (Number.isFinite(lastSeenMs) && now - lastSeenMs <= 3500) {
        active.push(reader);
      } else {
        this.stateReaders.delete(id);
      }
    }
    return active;
  }

  health(context = {}) {
    return {
      ok: true,
      service: 'visual-modbus-robot-controller',
      protocol: 'modbus-tcp',
      transport: 'local-http-bridge-for-browser',
      timestampUtc: new Date().toISOString(),
      controllerEndpoint: context.controllerEndpoint,
      client: {
        ip: cleanRemoteAddress(context.clientIp),
        port: context.clientPort,
      },
      connectedClients: this.activeClients(),
      stateReaders: this.activeStateReaders(),
      clientAccepted: this.isClientAccepted(context.clientId),
    };
  }

  resolveJointId(key) {
    const normalized = String(key ?? '').trim().toLowerCase();
    if (this.values[normalized] !== undefined) return normalized;
    const display = Number(normalized.replace(/^hr\s*/i, '').replace(/^reported_/, '').replace(/^j/, ''));
    if (Number.isInteger(display) && display >= 1 && display <= DEFAULT_JOINTS.length && normalized.startsWith('reported_j')) return `j${display}`;
    const numeric = Number(normalized.replace(/^hr\s*/i, ''));
    if (!Number.isInteger(numeric)) return undefined;
    return DEFAULT_JOINTS.find((joint) => Number(joint.displayAddress) === numeric)?.id;
  }

  setCycle(enabled) {
    this.cycleEnabled = enabled;
    if (enabled) this.startedAt = Date.now();
  }

  home() {
    this.cycleEnabled = false;
    DEFAULT_JOINTS.forEach((joint) => {
      this.values[joint.id] = 0;
    });
  }

  write(key, value) {
    const jointId = this.resolveJointId(key);
    if (!jointId) throw new Error(`Unknown joint/register ${key}`);
    const joint = DEFAULT_JOINTS.find((candidate) => candidate.id === jointId);
    this.values[jointId] = clamp(Number(value), joint.lower, joint.upper);
    this.cycleEnabled = false;
    return { jointId, value: this.values[jointId] };
  }

  nudge(key, delta) {
    const jointId = this.resolveJointId(key);
    if (!jointId) throw new Error(`Unknown joint/register ${key}`);
    return this.write(jointId, this.values[jointId] + Number(delta));
  }

  applyCycle() {
    if (!this.cycleEnabled) return;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const next = {
      j1: Math.sin(elapsed * 0.42) * 1.1,
      j2: -0.35 + Math.sin(elapsed * 0.55) * 0.75,
      j3: 0.55 + Math.sin(elapsed * 0.67 + 0.8) * 0.85,
      j4: Math.sin(elapsed * 0.9 + 1.4) * 1.2,
      j5: Math.sin(elapsed * 0.73 + 2.1) * 1.55,
      j6: Math.sin(elapsed * 1.1) * 1.45,
    };
    DEFAULT_JOINTS.forEach((joint) => {
      this.values[joint.id] = clamp(next[joint.id], joint.lower, joint.upper);
    });
  }

  snapshot(context = {}) {
    this.applyCycle();
    this.sequence += 1;
    const registers = DEFAULT_JOINTS.map((joint) => {
      const registersWords = encodeF32Words(this.values[joint.id]);
      return {
        address: joint.address,
        displayAddress: joint.displayAddress,
        signalId: `reported_${joint.id}`,
        jointId: joint.id,
        jointName: joint.name,
        value: this.values[joint.id],
        registers: registersWords,
        dataType: 'f32',
        byteOrder: 'be',
        wordOrder: 'high-low',
        area: 'holding-register',
      };
    });
    const flatWords = registers.flatMap((register) => register.registers);
    const requestPdu = [0x03, 0x00, 0x64, 0x00, flatWords.length];
    const responsePdu = [0x03, flatWords.length * 2, ...flatWords.flatMap((word) => [(word >> 8) & 0xff, word & 0xff])];
    const packets = [
      {
        direction: 'request',
        transactionId: this.sequence,
        unitId: this.unitId,
        functionCode: 3,
        area: 'holding-register',
        address: 100,
        quantity: flatWords.length,
        bindingIds: registers.map((register) => register.signalId),
        hex: modbusTcpHex(this.sequence, this.unitId, requestPdu),
        decoded: `Read Holding Registers 40101-${40100 + flatWords.length}`,
      },
      {
        direction: 'response',
        transactionId: this.sequence,
        unitId: this.unitId,
        functionCode: 3,
        area: 'holding-register',
        address: 100,
        quantity: flatWords.length,
        bindingIds: registers.map((register) => register.signalId),
        hex: modbusTcpHex(this.sequence, this.unitId, responsePdu),
        decoded: `${flatWords.length} registers: ${wordsToHex(flatWords)}`,
      },
    ];
    return {
      schemaVersion: 1,
      name: 'Visual Modbus Robot Controller',
      protocol: 'modbus-tcp',
      transport: 'local-http-bridge-for-browser',
      connectionId: 'visual-plc01',
      controllerEndpoint: context.controllerEndpoint,
      client: {
        ip: cleanRemoteAddress(context.clientIp),
        port: context.clientPort,
      },
      connectedClients: this.activeClients(),
      stateReaders: this.activeStateReaders(),
      clientAccepted: this.isClientAccepted(context.clientId),
      unitId: this.unitId,
      sequence: this.sequence,
      timestampUtc: new Date().toISOString(),
      cycleEnabled: this.cycleEnabled,
      registers,
      modbusPackets: packets,
    };
  }
}

const controllerHtml = (endpoint) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Digital Twin Modbus Controller</title>
  <style>
    :root { color: #edf1f3; background: #111417; font-family: Inter, ui-sans-serif, system-ui, Segoe UI, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 50% 0%, #26323a 0, #111417 46%); }
    button, input { font: inherit; }
    .shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; gap: 18px; padding: 18px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border: 1px solid #303a42; border-radius: 8px; background: rgba(24, 28, 31, .9); }
    h1 { margin: 0; font-size: 19px; }
    header p { margin: 2px 0 0; color: #aeb8bf; font-size: 12px; }
    .status { display: flex; gap: 8px; align-items: center; color: #d4b35b; font-size: 12px; }
    .status.connected { color: #bffbf5; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #d4b35b; box-shadow: 0 0 15px rgba(212,179,91,.55); }
    .status.connected .dot { background: #55d6ca; box-shadow: 0 0 15px #55d6ca; }
    .layout { display: grid; grid-template-columns: minmax(310px, 480px) minmax(320px, 1fr); gap: 18px; min-height: 0; }
    .pad, .panel { min-width: 0; border: 1px solid #303a42; border-radius: 8px; background: rgba(24, 28, 31, .88); box-shadow: 0 20px 45px rgba(0,0,0,.28); }
    .pad { min-height: 560px; padding: 18px; display: grid; grid-template-rows: auto 1fr auto; gap: 16px; }
    .pad-head { display: flex; justify-content: space-between; gap: 12px; }
    .pad-head strong { display: block; font-size: 14px; }
    .pad-head span { color: #aeb8bf; font-size: 12px; }
    .connect-panel { display: grid; grid-template-columns: minmax(120px, 1fr) 82px auto auto; gap: 8px; align-items: end; padding: 10px; border: 1px solid #303a42; border-radius: 7px; background: rgba(18,22,25,.74); }
    .connect-panel label { display: grid; gap: 4px; color: #aeb8bf; font-size: 11px; }
    .connect-panel input { min-height: 34px; border: 1px solid #3a4650; border-radius: 6px; background: #15191c; color: #edf1f3; padding: 0 10px; }
    .connect-panel button { min-height: 34px; border: 1px solid #55d6ca; border-radius: 6px; background: #c45114; color: #fff8ec; font-weight: 800; cursor: pointer; padding: 0 12px; }
    .connect-panel button.secondary { border-color: #59626a; background: #252b30; color: #dfe7eb; }
    .ble-panel { display: grid; gap: 8px; padding: 10px; border: 1px solid #394149; border-radius: 7px; background: rgba(12, 18, 22, .76); }
    .ble-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
    .ble-head strong { display: block; font-size: 13px; }
    .ble-head span { display: block; color: #aeb8bf; font-size: 11px; }
    .ble-actions { display: flex; flex-wrap: wrap; gap: 7px; justify-content: flex-end; }
    .ble-actions button { min-height: 30px; border: 1px solid #3a4650; border-radius: 6px; background: #252b30; color: #edf1f3; padding: 0 9px; cursor: pointer; white-space: nowrap; }
    .ble-actions .hot { border-color: #55d6ca; background: #c45114; color: #fff8ec; font-weight: 800; }
    .ble-actions .calibrate-hot { border-color: #ffce73; background: #7d3b0f; color: #fff8ec; font-weight: 900; box-shadow: 0 0 0 1px rgba(255,206,115,.25), 0 0 18px rgba(232,102,31,.22); }
    .ble-profile-row { display: grid; grid-template-columns: 120px minmax(180px, 1fr); gap: 8px; align-items: center; padding: 7px 8px; border: 1px solid #303a42; border-radius: 7px; background: rgba(18,22,25,.74); }
    .ble-profile-row span { color: #dfe7eb; font-size: 12px; }
    .ble-profile-row select { min-height: 30px; border: 1px solid #3a4650; border-radius: 5px; background: #15191c; color: #edf1f3; padding: 0 8px; font-size: 12px; }
    .ble-status-line { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; color: #aeb8bf; font-size: 11px; }
    .ble-pill { padding: 3px 7px; border: 1px solid #394149; border-radius: 999px; color: #d4b35b; }
    .ble-pill.live { border-color: #55d6ca; color: #bffbf5; }
    .ble-scale-stack { display: grid; gap: 5px; }
    .ble-scale-row { display: grid; grid-template-columns: 58px minmax(120px, 1fr) 58px 48px; gap: 8px; align-items: center; padding: 7px 8px; border: 1px solid #303a42; border-radius: 7px; background: rgba(18,22,25,.74); }
    .ble-scale-row span { color: #dfe7eb; font-size: 12px; }
    .ble-scale-row input[type="range"] { width: 100%; accent-color: #e8661f; }
    .ble-scale-row input[type="number"] { min-height: 28px; border: 1px solid #3a4650; border-radius: 5px; background: #15191c; color: #edf1f3; padding: 0 6px; font-size: 12px; }
    .ble-scale-row strong { color: #55d6ca; font-size: 13px; text-align: right; }
    .ble-axis-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
    .ble-axis { padding: 6px 7px; border: 1px solid #303a42; border-radius: 6px; background: rgba(18,22,25,.74); }
    .ble-axis span { display: block; color: #aeb8bf; font-size: 10px; }
    .ble-axis strong { display: block; margin-top: 2px; color: #55d6ca; font-size: 13px; }
    .ble-device-list { display: grid; gap: 6px; }
    .ble-device-card { display: grid; grid-template-columns: minmax(150px, 1fr) repeat(3, 64px) auto auto; gap: 6px; align-items: center; padding: 7px; border: 1px solid #303a42; border-radius: 7px; background: rgba(18,22,25,.74); }
    .ble-device-card.active { border-color: #55d6ca; background: rgba(17,78,74,.34); }
    .ble-device-card strong { display: block; color: #edf1f3; font-size: 12px; }
    .ble-device-card span { display: block; color: #aeb8bf; font-size: 10px; margin-top: 2px; }
    .ble-device-card code { color: #bffbf5; font-size: 11px; }
    .ble-device-card button { min-height: 26px; border: 1px solid #3a4650; border-radius: 5px; background: #252b30; color: #edf1f3; cursor: pointer; font-size: 11px; padding: 0 8px; }
    .ble-device-card button.active { border-color: #e8661f; background: #c45114; color: #fff8ec; font-weight: 800; }
    .ble-map { display: grid; gap: 5px; }
    .ble-map-row { display: grid; gap: 6px; padding: 7px; border: 1px solid #303a42; border-radius: 7px; background: rgba(18,22,25,.74); }
    .ble-map-row span { color: #dfe7eb; font-size: 11px; }
    .ble-map-row button { min-height: 26px; border: 1px solid #3a4650; border-radius: 5px; background: #1a2024; color: #aeb8bf; cursor: pointer; font-size: 11px; }
    .ble-map-row button.active { border-color: #e8661f; background: #3d2816; color: #ffd8bd; font-weight: 800; }
    .ble-source-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 6px; }
    .ble-source-group { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; align-items: center; padding: 5px; border: 1px solid #263039; border-radius: 6px; background: rgba(10,13,15,.32); }
    .ble-source-group strong { grid-column: 1 / -1; color: #55d6ca; font-size: 10px; }
    .ble-none-button { width: 100%; }
    .ble-calibration { display: grid; gap: 8px; padding: 8px; border: 1px solid #303a42; border-radius: 7px; background: rgba(18,22,25,.74); }
    .ble-calibration-head { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    .ble-calibration-head strong { display: block; font-size: 12px; color: #edf1f3; }
    .ble-calibration-head span { display: block; margin-top: 2px; color: #aeb8bf; font-size: 10px; }
    .ble-calibration-controls { display: grid; grid-template-columns: minmax(105px, 1fr) repeat(3, auto); gap: 6px; align-items: center; }
    .ble-calibration-controls select { min-height: 28px; border: 1px solid #3a4650; border-radius: 5px; background: #15191c; color: #edf1f3; padding: 0 6px; font-size: 11px; }
    .ble-calibration-controls button { min-height: 28px; border: 1px solid #3a4650; border-radius: 5px; background: #252b30; color: #edf1f3; padding: 0 8px; cursor: pointer; font-size: 11px; }
    .ble-calibration-controls .hot { border-color: #55d6ca; background: #c45114; color: #fff8ec; font-weight: 800; }
    .ble-calibration-status { min-height: 34px; color: #bffbf5; font-size: 11px; line-height: 1.35; }
    .ble-calibration-guide { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; color: #cbd5da; font-size: 10px; line-height: 1.3; }
    .ble-calibration-guide div { padding: 5px 6px; border: 1px solid #303a42; border-radius: 5px; background: rgba(10,13,15,.36); }
    .ble-calibration-guide strong { color: #ffce73; }
    .ble-calibration-report { display: grid; gap: 4px; max-height: 88px; overflow: auto; color: #aeb8bf; font-size: 10px; }
    .ble-calibration-report div { padding: 4px 6px; border-left: 3px solid #55d6ca; background: rgba(10,13,15,.45); }
    .actions { display: flex; gap: 8px; }
    .actions button, .small { min-height: 34px; border: 1px solid #3a4650; border-radius: 6px; background: #252b30; color: #edf1f3; padding: 0 11px; cursor: pointer; }
    .actions button:hover, .small:hover { border-color: #55d6ca; }
    .actions .hot { background: #c45114; border-color: #55d6ca; color: #fff8ec; font-weight: 800; }
    button:disabled, input:disabled { opacity: .45; cursor: default; }
    .gamepad { position: relative; display: grid; grid-template-columns: 1fr 1fr; align-items: center; gap: 18px; padding: 20px; border-radius: 26px; background: linear-gradient(145deg, #2b3136, #181d21); border: 1px solid #44505a; }
    .dpad, .face { display: grid; grid-template-columns: repeat(3, 58px); grid-template-rows: repeat(3, 58px); justify-content: center; gap: 8px; }
    .face { transform: rotate(45deg); }
    .face button span { transform: rotate(-45deg); }
    .round, .dpad button { border: 1px solid #54606a; background: #14181b; color: #edf1f3; border-radius: 16px; min-height: 58px; cursor: pointer; font-weight: 800; }
    .round:active, .dpad button:active { background: #e8661f; color: white; transform: translateY(1px); }
    .blank { visibility: hidden; }
    .sticks { grid-column: 1 / span 2; display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 10px 30px 4px; }
    .stick { aspect-ratio: 1; border-radius: 50%; border: 1px solid #54606a; background: radial-gradient(circle, #222a30 0 31%, #111417 33% 100%); display: grid; place-items: center; color: #55d6ca; font-size: 12px; }
    .triggers { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .triggers button { min-height: 38px; border-radius: 8px; border: 1px solid #3a4650; background: #252b30; color: #edf1f3; cursor: pointer; }
    .registers { display: grid; gap: 8px; }
    .row { display: grid; grid-template-columns: 92px 1fr 70px; gap: 10px; align-items: center; padding: 8px; border: 1px solid #303a42; border-radius: 7px; background: rgba(18, 22, 25, .72); }
    .row span { color: #dfe7eb; font-size: 12px; }
    .row input { width: 100%; accent-color: #e8661f; }
    .row strong { color: #55d6ca; font-size: 12px; text-align: right; }
    .panel { min-height: 560px; display: grid; grid-template-rows: auto 1fr auto; gap: 12px; padding: 14px; }
    .panel h2 { margin: 0; font-size: 15px; }
    .packet-list, .map { display: grid; gap: 7px; align-content: start; overflow: auto; }
    .map-row, .packet { border: 1px solid #303a42; border-left: 4px solid #55d6ca; border-radius: 7px; padding: 8px; background: rgba(18,22,25,.74); }
    .packet.request { border-left-color: #e8661f; }
    .packet strong, .map-row strong { display: block; font-size: 12px; }
    .packet code, .map-row code { display: block; margin-top: 5px; color: #dfe7eb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
    .hint { color: #aeb8bf; font-size: 12px; line-height: 1.45; }
    .empty { min-height: 86px; display: grid; place-items: center; border: 1px dashed #3a4650; border-radius: 7px; color: #aeb8bf; font-size: 12px; text-align: center; padding: 12px; }
    .endpoint { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
    .endpoint div { min-width: 0; padding: 8px; border: 1px solid #303a42; border-radius: 7px; background: rgba(18,22,25,.74); }
    .endpoint span { display: block; color: #aeb8bf; font-size: 11px; }
    .endpoint strong, .endpoint code { display: block; margin-top: 3px; color: #bffbf5; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @media (max-width: 980px) { .layout { grid-template-columns: 1fr; } .gamepad { grid-template-columns: 1fr; } .sticks { grid-column: auto; grid-template-columns: 1fr 1fr; } .ble-map-row { grid-template-columns: minmax(118px, 1.5fr) repeat(4, minmax(0, 1fr)); } }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <h1>Digital Twin Modbus Controller</h1>
        <p>Visual PLC/gamepad for holding registers HR 40101-40111</p>
      </div>
      <div class="status" id="connection-status"><span class="dot"></span><span id="status">not connected</span><span id="active-endpoint">${endpoint.host}:${endpoint.port}</span><span id="platform-rx-status">Platform RX off</span><span id="ble-header-status">BLE idle</span></div>
    </header>
    <section class="layout">
      <div class="pad">
        <div class="pad-head">
          <div><strong>Visual Robot Controller</strong><span>Use buttons, sliders, keyboard or a browser gamepad.</span></div>
          <div class="actions">
            <button class="hot" id="cycle">Cycle</button>
            <button id="home">Home</button>
          </div>
        </div>
        <div class="connect-panel">
          <label>Controller IP <input id="controller-ip" value="${endpoint.host}" autocomplete="off"></label>
          <label>Port <input id="controller-port" value="${endpoint.port}" inputmode="numeric" autocomplete="off"></label>
          <button id="connect">Connect</button>
          <button class="secondary" id="disconnect-platform">Disconnect Platform</button>
        </div>
        <div class="ble-panel">
          <div class="ble-head">
            <div><strong>BLE TI SensorTag / Keyfob</strong><span>Map one axis or combined X/Y/Z movement to Modbus HR registers.</span></div>
            <div class="ble-actions">
              <button class="hot" id="ble-connect">Connect BLE Device</button>
              <button class="calibrate-hot" id="ble-calibrate-all-top">Auto Calibrate All Joints</button>
              <button id="ble-stop">Disconnect Active BLE</button>
              <button id="ble-stop-all">Disconnect All BLE</button>
            </div>
          </div>
          <label class="ble-profile-row">
            <span>BLE Device</span>
            <select id="ble-profile" aria-label="BLE device profile">
              <option value="auto">Auto detect TI profile</option>
              <option value="cc2650">CC2650 SensorTag Movement</option>
              <option value="cc2541-sensortag">CC2541 SensorTag Accelerometer</option>
              <option value="cc2541-keyfob">CC2541 Keyfob Accelerometer</option>
            </select>
          </label>
          <div class="ble-status-line">
            <span class="ble-pill" id="ble-status">BLE idle</span>
            <span id="ble-device">no device</span>
            <span id="ble-rate">0 samples/s</span>
          </div>
          <div class="ble-device-list" id="ble-devices"><div class="empty">No BLE devices connected.</div></div>
          <div class="ble-axis-grid">
            <div class="ble-axis"><span>X</span><strong id="ble-axis-x">0.000</strong></div>
            <div class="ble-axis"><span>Y</span><strong id="ble-axis-y">0.000</strong></div>
            <div class="ble-axis"><span>Z</span><strong id="ble-axis-z">0.000</strong></div>
          </div>
          <div class="ble-scale-stack" aria-label="BLE per-axis movement scale">
            <label class="ble-scale-row">
              <span>X Scale</span>
              <input id="ble-gain-range-x" data-ble-gain-range="x" type="range" min="0.1" max="10" step="0.1" value="3.0">
              <input id="ble-gain-x" data-ble-gain="x" type="number" min="0.1" max="10" step="0.1" value="3.0">
              <strong id="ble-gain-value-x">x3.0</strong>
            </label>
            <label class="ble-scale-row">
              <span>Y Scale</span>
              <input id="ble-gain-range-y" data-ble-gain-range="y" type="range" min="0.1" max="10" step="0.1" value="3.0">
              <input id="ble-gain-y" data-ble-gain="y" type="number" min="0.1" max="10" step="0.1" value="3.0">
              <strong id="ble-gain-value-y">x3.0</strong>
            </label>
            <label class="ble-scale-row">
              <span>Z Scale</span>
              <input id="ble-gain-range-z" data-ble-gain-range="z" type="range" min="0.1" max="10" step="0.1" value="3.0">
              <input id="ble-gain-z" data-ble-gain="z" type="number" min="0.1" max="10" step="0.1" value="3.0">
              <strong id="ble-gain-value-z">x3.0</strong>
            </label>
          </div>
          <div class="ble-calibration">
            <div class="ble-calibration-head">
              <div><strong>Automatic Calibration</strong><span>Move the SensorTag in the intended positive direction while samples are recorded.</span></div>
            </div>
            <div class="ble-calibration-controls">
              <select id="ble-calibration-joint" aria-label="Calibration target register">
                ${DEFAULT_JOINTS.map((joint) => `<option value="${joint.id}">HR ${joint.displayAddress} ${joint.id.toUpperCase()}</option>`).join('')}
              </select>
              <button class="hot" id="ble-calibrate-current">Calibrate Selected HR</button>
              <button id="ble-calibrate-all">Auto Calibrate All Joints</button>
              <button id="ble-calibration-clear">Clear</button>
            </div>
            <div class="ble-calibration-status" id="ble-calibration-status">Calibration idle. Connect Modbus and BLE, then calibrate one HR or the full chain.</div>
            <div class="ble-calibration-guide" id="ble-calibration-guide">
              ${DEFAULT_JOINTS.map((joint) => `<div><strong>${joint.id.toUpperCase()}</strong> ${JOINT_DIRECTION_GUIDES[joint.id].intent}: +${JOINT_DIRECTION_GUIDES[joint.id].positive} / -${JOINT_DIRECTION_GUIDES[joint.id].negative}</div>`).join('')}
            </div>
            <div class="ble-calibration-report" id="ble-calibration-report"></div>
          </div>
          <div class="ble-map" id="ble-map"></div>
        </div>
        <div class="gamepad">
          <div class="dpad">
            <button class="blank"></button><button data-nudge="j2:0.08">J2+</button><button class="blank"></button>
            <button data-nudge="j1:-0.08">J1-</button><button data-nudge="j6:0.08">J6+</button><button data-nudge="j1:0.08">J1+</button>
            <button class="blank"></button><button data-nudge="j2:-0.08">J2-</button><button class="blank"></button>
          </div>
          <div class="face">
            <button class="blank"></button><button class="round" data-nudge="j3:0.08"><span>J3+</span></button><button class="blank"></button>
            <button class="round" data-nudge="j4:-0.08"><span>J4-</span></button><button class="round" data-nudge="j6:-0.08"><span>J6-</span></button><button class="round" data-nudge="j4:0.08"><span>J4+</span></button>
            <button class="blank"></button><button class="round" data-nudge="j3:-0.08"><span>J3-</span></button><button class="blank"></button>
          </div>
          <div class="sticks">
            <div class="stick">Left stick: J1/J2</div>
            <div class="stick">Right stick: J3/J4</div>
          </div>
        </div>
        <div class="triggers">
          <button data-nudge="j5:-0.08">L1 J5-</button>
          <button data-nudge="j5:0.08">R1 J5+</button>
          <button data-nudge="j6:-0.12">J6-</button>
          <button data-nudge="j6:0.12">J6+</button>
        </div>
        <div class="registers" id="registers"></div>
      </div>
      <div class="panel">
        <div>
          <h2>Live Modbus TCP</h2>
          <p class="hint">Set IP and port, press Connect, then open the platform, select a robot, press Digital Twin Scenario and Visual Controller. Both sides must use the same endpoint.</p>
          <div class="endpoint">
            <div><span>Controller IP</span><strong>${endpoint.host}</strong></div>
            <div><span>Controller Port</span><strong>${endpoint.port}</strong></div>
            <div><span>State URL</span><code>${endpoint.stateUrl}</code></div>
            <div><span>Write URL</span><code>${endpoint.writeUrl}</code></div>
          </div>
        </div>
        <div>
          <div class="map" id="map"></div>
          <h2 style="margin-top:14px">Packets</h2>
          <div class="packet-list" id="packets"></div>
        </div>
        <p class="hint">Keyboard: arrows control J1/J2, WASD controls J3/J4, Q/E controls J5, Z/X controls J6 tool roll.</p>
      </div>
    </section>
  </main>
  <script>
    const state = { registers: [], lastGamepadWrite: 0, connected: false, baseUrl: '', sessionId: '' };
    const limits = { j1:[-3.14,3.14], j2:[-1.75,1.75], j3:[-2.2,2.2], j4:[-3.14,3.14], j5:[-3.14,3.14], j6:[-3.14,3.14] };
    const jointGuides = ${JSON.stringify(JOINT_DIRECTION_GUIDES)};
    const bleRows = [
      { jointId:'j1', displayAddress:'40101', label:'HR 40101 J1 base derecha/izquierda' },
      { jointId:'j2', displayAddress:'40103', label:'HR 40103 J2 hombro delante/atras' },
      { jointId:'j3', displayAddress:'40105', label:'HR 40105 J3 arriba/abajo' },
      { jointId:'j4', displayAddress:'40107', label:'HR 40107 J4 muneca arriba/abajo' },
      { jointId:'j5', displayAddress:'40109', label:'HR 40109 J5 muneca derecha/izquierda' },
      { jointId:'j6', displayAddress:'40111', label:'HR 40111 J6 giro herramienta' },
    ];
    const expandBleUuid = (uuid) => {
      if (typeof uuid === 'number') return '0000' + uuid.toString(16).padStart(4, '0') + '-0000-1000-8000-00805f9b34fb';
      const value = String(uuid ?? '').trim().toLowerCase();
      if (/^0x[0-9a-f]{4}$/.test(value)) return '0000' + value.slice(2) + '-0000-1000-8000-00805f9b34fb';
      if (/^[0-9a-f]{4}$/.test(value)) return '0000' + value + '-0000-1000-8000-00805f9b34fb';
      return value;
    };
    const tiBleProfiles = {
      cc2650: {
        id:'cc2650',
        label:'CC2650 SensorTag Movement',
        service:'f000aa80-0451-4000-b000-000000000000',
        data:'f000aa81-0451-4000-b000-000000000000',
        config:'f000aa82-0451-4000-b000-000000000000',
        period:'f000aa83-0451-4000-b000-000000000000',
        enableValue:[0x7f, 0x00],
        disableValue:[0x00],
        periodValue:[10],
        parser:'cc2650',
      },
      'cc2541-sensortag': {
        id:'cc2541-sensortag',
        label:'CC2541 SensorTag Accelerometer',
        service:'f000aa10-0451-4000-b000-000000000000',
        data:'f000aa11-0451-4000-b000-000000000000',
        config:'f000aa12-0451-4000-b000-000000000000',
        period:'f000aa13-0451-4000-b000-000000000000',
        enableValue:[0x01],
        disableValue:[0x00],
        periodValue:[10],
        parser:'cc2541-sensortag',
      },
      'cc2541-keyfob': {
        id:'cc2541-keyfob',
        label:'CC2541 Keyfob Accelerometer',
        service:expandBleUuid(0xffa0),
        config:expandBleUuid(0xffa1),
        range:expandBleUuid(0xffa2),
        axes:{ x:expandBleUuid(0xffa3), y:expandBleUuid(0xffa4), z:expandBleUuid(0xffa5) },
        period:expandBleUuid(0xffa6),
        enableValue:[0x01],
        disableValue:[0x00],
        rangeValue:[0x20, 0x00],
        periodValue:[10],
        parser:'cc2541-keyfob',
      },
    };
    const sensorTag = {
      devices:new Map(),
      activeDeviceId:'',
      device:null,
      activeProfile:null,
      characteristics:[],
      notificationHandlers:[],
      axisCharacteristics:{},
      configCharacteristic:null,
      periodCharacteristic:null,
      rangeCharacteristic:null,
      pollTimer:null,
      keyfobAxes:{ x:0, y:0, z:0 },
      connected:false,
      firstNotificationTimer:null,
      baseline:null,
      axes:{ x:0, y:0, z:0 },
      smooth:{ x:0, y:0, z:0 },
      samples:[],
      lastPublish:0,
      lastRawHex:'',
      gains:{ x:3, y:3, z:3 },
      map:{},
      axisSigns:{},
      calibration:{
        active:false,
        phase:'idle',
        queue:[],
        jointId:'',
        startedAt:0,
        prepareMs:1800,
        durationMs:4200,
        samples:[],
        previewAt:0,
        prepareTimer:null,
        timer:null,
        results:[],
      },
    };
    const controls = () => Array.from(document.querySelectorAll('.pad-head button, .gamepad button, .triggers button, [data-slider]'));
    const endpointFromInputs = () => {
      const host = document.getElementById('controller-ip').value.trim() || '127.0.0.1';
      const port = document.getElementById('controller-port').value.trim() || '8765';
      return { host, port, baseUrl: 'http://' + host + ':' + port };
    };
    const setControlsEnabled = (enabled) => controls().forEach((control) => { control.disabled = !enabled; });
    const setConnectionUi = (connected, text) => {
      state.connected = connected;
      document.getElementById('connection-status').classList.toggle('connected', connected);
      document.getElementById('status').textContent = text;
      document.getElementById('active-endpoint').textContent = state.baseUrl ? state.baseUrl.replace(/^https?:\\/\\//, '') : endpointFromInputs().host + ':' + endpointFromInputs().port;
      setControlsEnabled(connected);
    };
    const bleAxes = ['x', 'y', 'z'];
    const saveBleMap = () => localStorage.setItem('assetForge.bleAxisMap', JSON.stringify(sensorTag.map));
    const saveBleAxisSigns = () => localStorage.setItem('assetForge.bleAxisSigns', JSON.stringify(sensorTag.axisSigns));
    const saveBleCalibrationProfile = () => localStorage.setItem('assetForge.bleCalibrationProfile', JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      map: sensorTag.map,
      axisSigns: sensorTag.axisSigns,
      gains: sensorTag.gains,
      results: sensorTag.calibration.results.slice(-12),
    }));
    const clampBleGain = (value) => Math.max(0.1, Math.min(10, Number.isFinite(Number(value)) ? Number(value) : 3));
    const normalizeBleAxisList = (value) => {
      const raw = Array.isArray(value) ? value : (bleAxes.includes(value) ? [value] : []);
      return Array.from(new Set(raw.filter((axis) => bleAxes.includes(axis))));
    };
    const normalizeBleMapEntry = (value) => {
      if (Array.isArray(value) || bleAxes.includes(value)) return { source:'active', axes:normalizeBleAxisList(value) };
      return {
        source:String(value?.source ?? 'active'),
        axes:normalizeBleAxisList(value?.axes),
      };
    };
    const normalizeBleAxisSigns = (value) => Object.fromEntries(bleAxes.map((axis) => [axis, Number(value?.[axis]) < 0 ? -1 : 1]));
    const saveBleGains = () => localStorage.setItem('assetForge.bleAxisGains', JSON.stringify(sensorTag.gains));
    const renderBleGains = () => {
      bleAxes.forEach((axis) => {
        const value = clampBleGain(sensorTag.gains[axis]).toFixed(1);
        sensorTag.gains[axis] = Number(value);
        document.getElementById('ble-gain-' + axis).value = value;
        document.getElementById('ble-gain-range-' + axis).value = value;
        document.getElementById('ble-gain-value-' + axis).textContent = 'x' + value;
      });
    };
    const loadBleGains = () => {
      try {
        const storedText = localStorage.getItem('assetForge.bleAxisGains');
        if (!storedText) throw new Error('NO_AXIS_GAINS');
        const stored = JSON.parse(storedText);
        sensorTag.gains = Object.fromEntries(bleAxes.map((axis) => [axis, clampBleGain(stored[axis] ?? 3)]));
      } catch {
        const legacyGain = localStorage.getItem('assetForge.bleGain');
        const migrated = clampBleGain(legacyGain || 3);
        sensorTag.gains = { x:migrated, y:migrated, z:migrated };
      }
      renderBleGains();
      saveBleGains();
    };
    const loadBleMap = () => {
      try {
        const stored = JSON.parse(localStorage.getItem('assetForge.bleAxisMap') || '{}');
        sensorTag.map = Object.fromEntries(bleRows.map((row) => [row.jointId, normalizeBleMapEntry(stored[row.jointId])]));
      } catch {
        sensorTag.map = Object.fromEntries(bleRows.map((row) => [row.jointId, { source:'active', axes:[] }]));
      }
    };
    const loadBleAxisSigns = () => {
      try {
        const stored = JSON.parse(localStorage.getItem('assetForge.bleAxisSigns') || '{}');
        sensorTag.axisSigns = Object.fromEntries(bleRows.map((row) => [row.jointId, normalizeBleAxisSigns(stored[row.jointId])]));
      } catch {
        sensorTag.axisSigns = Object.fromEntries(bleRows.map((row) => [row.jointId, normalizeBleAxisSigns()]));
      }
    };
    const loadBleCalibrationProfile = () => {
      try {
        const stored = JSON.parse(localStorage.getItem('assetForge.bleCalibrationProfile') || '{}');
        sensorTag.calibration.results = Array.isArray(stored.results) ? stored.results : [];
      } catch {
        sensorTag.calibration.results = [];
      }
    };
    const setBleStatus = (text, live = false) => {
      const status = document.getElementById('ble-status');
      status.textContent = text;
      status.classList.toggle('live', live);
      document.getElementById('ble-header-status').textContent = text;
    };
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
    const newBleDeviceId = () => 'ble-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const nextBleDeviceSlot = () => {
      const used = new Set(Array.from(sensorTag.devices.values()).map((context) => context.slot));
      for (let slot = 1; slot < 100; slot += 1) if (!used.has(slot)) return slot;
      return sensorTag.devices.size + 1;
    };
    const createBleDeviceContext = (device, session) => ({
      id:newBleDeviceId(device),
      slot:nextBleDeviceSlot(),
      label:device.name || device.id || 'TI BLE device',
      device,
      profile:session.profile,
      activeProfile:session.profile,
      characteristics:session.data ? [session.data] : Object.values(session.axisCharacteristics || {}),
      notificationHandlers:[],
      axisCharacteristics:session.axisCharacteristics || {},
      configCharacteristic:session.config,
      periodCharacteristic:session.period,
      rangeCharacteristic:session.range,
      pollTimer:null,
      keyfobAxes:{ x:0, y:0, z:0 },
      connected:false,
      firstNotificationTimer:null,
      baseline:null,
      axes:{ x:0, y:0, z:0 },
      smooth:{ x:0, y:0, z:0 },
      samples:[],
      lastRawHex:'',
      lastSeenAt:0,
      lastPublish:0,
    });
    const activeBleContext = () => sensorTag.devices.get(sensorTag.activeDeviceId);
    const syncActiveBleContext = () => {
      const context = activeBleContext();
      if (!context) {
        sensorTag.device = null;
        sensorTag.activeProfile = null;
        sensorTag.characteristics = [];
        sensorTag.notificationHandlers = [];
        sensorTag.axisCharacteristics = {};
        sensorTag.configCharacteristic = null;
        sensorTag.periodCharacteristic = null;
        sensorTag.rangeCharacteristic = null;
        sensorTag.pollTimer = null;
        sensorTag.keyfobAxes = { x:0, y:0, z:0 };
        sensorTag.connected = false;
        sensorTag.firstNotificationTimer = null;
        sensorTag.baseline = null;
        sensorTag.axes = { x:0, y:0, z:0 };
        sensorTag.smooth = { x:0, y:0, z:0 };
        sensorTag.samples = [];
        sensorTag.lastRawHex = '';
        return;
      }
      sensorTag.device = context.device;
      sensorTag.activeProfile = context.profile;
      sensorTag.characteristics = context.characteristics;
      sensorTag.notificationHandlers = context.notificationHandlers;
      sensorTag.axisCharacteristics = context.axisCharacteristics;
      sensorTag.configCharacteristic = context.configCharacteristic;
      sensorTag.periodCharacteristic = context.periodCharacteristic;
      sensorTag.rangeCharacteristic = context.rangeCharacteristic;
      sensorTag.pollTimer = context.pollTimer;
      sensorTag.keyfobAxes = context.keyfobAxes;
      sensorTag.connected = context.connected;
      sensorTag.firstNotificationTimer = context.firstNotificationTimer;
      sensorTag.baseline = context.baseline;
      sensorTag.axes = context.axes;
      sensorTag.smooth = context.smooth;
      sensorTag.samples = context.samples;
      sensorTag.lastRawHex = context.lastRawHex;
    };
    const setBleActiveDevice = (deviceId) => {
      if (!sensorTag.devices.has(deviceId)) return;
      sensorTag.activeDeviceId = deviceId;
      syncActiveBleContext();
      updateBleAxisUi();
      renderBleDevices();
      renderBleMap();
      const context = activeBleContext();
      setBleStatus(context?.connected ? 'BLE live' : 'BLE connected', Boolean(context?.connected));
      document.getElementById('ble-device').textContent = context ? context.label + ' | ' + context.profile.label + ' | active' : 'no device';
    };
    const clearBleContextRuntime = (context) => {
      if (!context) return;
      if (context.firstNotificationTimer) {
        clearTimeout(context.firstNotificationTimer);
        context.firstNotificationTimer = null;
      }
      if (context.pollTimer) {
        clearInterval(context.pollTimer);
        context.pollTimer = null;
      }
      context.notificationHandlers.forEach(({ characteristic, handler }) => {
        characteristic.removeEventListener?.('characteristicvaluechanged', handler);
      });
      context.notificationHandlers = [];
    };
    const renderBleDevices = () => {
      const container = document.getElementById('ble-devices');
      const devices = Array.from(sensorTag.devices.values());
      if (!devices.length) {
        container.innerHTML = '<div class="empty">No BLE devices connected.</div>';
        document.getElementById('ble-device').textContent = 'no device';
        document.getElementById('ble-rate').textContent = '0 samples/s';
        setBleStatus('BLE idle');
        return;
      }
      const now = Date.now();
      container.innerHTML = devices.map((context) => {
        const samples = context.samples.filter((sampleMs) => now - sampleMs < 1000).length;
        const active = context.id === sensorTag.activeDeviceId;
        return '<div class="ble-device-card ' + (active ? 'active' : '') + '">' +
          '<div><strong>IoT ' + context.slot + ' | ' + escapeHtml(context.label) + '</strong><span>' + escapeHtml(context.profile.label) + ' | ' + (context.connected ? samples + ' samples/s' : 'disconnected') + '</span></div>' +
          '<code>X' + context.slot + ' ' + context.smooth.x.toFixed(3) + '</code>' +
          '<code>Y' + context.slot + ' ' + context.smooth.y.toFixed(3) + '</code>' +
          '<code>Z' + context.slot + ' ' + context.smooth.z.toFixed(3) + '</code>' +
          '<button class="' + (active ? 'active' : '') + '" data-ble-active="' + context.id + '">' + (active ? 'Driving Robot' : 'Drive Robot') + '</button>' +
          '<button data-ble-disconnect="' + context.id + '">Disconnect</button>' +
          '</div>';
      }).join('');
      document.querySelectorAll('[data-ble-active]').forEach((button) => {
        button.onclick = () => setBleActiveDevice(button.dataset.bleActive);
      });
      document.querySelectorAll('[data-ble-disconnect]').forEach((button) => {
        button.onclick = () => stopBleDevice(button.dataset.bleDisconnect);
      });
    };
    const selectedBleProfiles = () => {
      const selected = document.getElementById('ble-profile')?.value || 'auto';
      if (selected !== 'auto') return [tiBleProfiles[selected]].filter(Boolean);
      return [tiBleProfiles.cc2650, tiBleProfiles['cc2541-sensortag'], tiBleProfiles['cc2541-keyfob']];
    };
    const allBleOptionalServices = () => Array.from(new Set(Object.values(tiBleProfiles).map((profile) => profile.service)));
    const characteristicMap = (characteristics) => new Map(characteristics.map((characteristic) => [expandBleUuid(characteristic.uuid), characteristic]));
    const findCharacteristic = (characteristics, uuid) => characteristicMap(characteristics).get(expandBleUuid(uuid));
    const requireBleGattProfile = async (server, profile) => {
      const service = await server.getPrimaryService(profile.service);
      const characteristics = await service.getCharacteristics();
      const config = findCharacteristic(characteristics, profile.config);
      const period = profile.period ? findCharacteristic(characteristics, profile.period) : null;
      if (profile.parser === 'cc2541-keyfob') {
        const axisCharacteristics = Object.fromEntries(bleAxes.map((axis) => [axis, findCharacteristic(characteristics, profile.axes[axis])]));
        if (!config || bleAxes.some((axis) => !axisCharacteristics[axis])) throw new Error('TI_BLE_GATT_PROFILE_INCOMPLETE');
        return {
          profile,
          config,
          period,
          range: profile.range ? findCharacteristic(characteristics, profile.range) : null,
          axisCharacteristics,
          data: null,
        };
      }
      const data = findCharacteristic(characteristics, profile.data);
      if (!data || !config) throw new Error('TI_BLE_GATT_PROFILE_INCOMPLETE');
      return { profile, data, config, period, range: null, axisCharacteristics: {} };
    };
    const renderBleMap = () => {
      document.getElementById('ble-map').innerHTML = bleRows.map((row) => {
        const selected = normalizeBleMapEntry(sensorTag.map[row.jointId]);
        const deviceSources = Array.from(sensorTag.devices.values()).map((context) => ({ source:String(context.slot), label:'IoT ' + context.slot }));
        const sources = [{ source:'active', label:'Active' }, ...deviceSources];
        const axisButton = (source, axis) => {
          const active = selected.source === source && selected.axes.includes(axis);
          const suffix = source === 'active' ? '' : source;
          return '<button data-ble-map="' + row.jointId + ':' + source + ':' + axis + '" class="' + (active ? 'active' : '') + '">' + axis.toUpperCase() + suffix + '</button>';
        };
        const groups = sources.map((source) =>
          '<div class="ble-source-group"><strong>' + source.label + '</strong>' +
          bleAxes.map((axis) => axisButton(source.source, axis)).join('') +
          '</div>'
        ).join('');
        const noneActive = selected.axes.length === 0;
        const summary = selected.axes.length ? ' | ' + selected.axes.map((axis) => axis.toUpperCase() + (selected.source === 'active' ? '' : selected.source)).join('+') : ' | none';
        return '<div class="ble-map-row"><span>' + row.label + summary + '</span><button class="ble-none-button ' + (noneActive ? 'active' : '') + '" data-ble-map="' + row.jointId + ':none:none">None</button><div class="ble-source-grid">' + groups + '</div></div>';
      }).join('');
      document.querySelectorAll('[data-ble-map]').forEach((button) => {
        button.onclick = () => {
          const parts = button.dataset.bleMap.split(':');
          const jointId = parts[0];
          const source = parts[1] || 'active';
          const axis = parts[2] || '';
          const selected = normalizeBleMapEntry(sensorTag.map[jointId]);
          if (source === 'none' || !axis) {
            sensorTag.map[jointId] = { source:'active', axes:[] };
          } else if (selected.source === source && selected.axes.includes(axis)) {
            sensorTag.map[jointId] = { source, axes:selected.axes.filter((candidate) => candidate !== axis) };
          } else {
            const axes = selected.source === source ? [...selected.axes, axis] : [axis];
            sensorTag.map[jointId] = { source, axes:Array.from(new Set(axes)) };
          }
          saveBleMap();
          saveBleCalibrationProfile();
          const sourceContext = bleContextForSource(normalizeBleMapEntry(sensorTag.map[jointId]).source);
          if (sourceContext) {
            sourceContext.lastPublish = 0;
            publishBleAxes(sourceContext);
          }
          renderBleMap();
        };
      });
    };
    const updateBleAxisUi = () => {
      syncActiveBleContext();
      document.getElementById('ble-axis-x').textContent = sensorTag.smooth.x.toFixed(3);
      document.getElementById('ble-axis-y').textContent = sensorTag.smooth.y.toFixed(3);
      document.getElementById('ble-axis-z').textContent = sensorTag.smooth.z.toFixed(3);
      const now = Date.now();
      const context = activeBleContext();
      sensorTag.samples = sensorTag.samples.filter((sampleMs) => now - sampleMs < 1000);
      if (context) context.samples = sensorTag.samples;
      document.getElementById('ble-rate').textContent = sensorTag.samples.length + ' samples/s';
      renderBleDevices();
    };
    const dataViewToHex = (dataView) => Array.from(new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const readInt16 = (dataView, offset) => (offset + 1 < dataView.byteLength ? dataView.getInt16(offset, true) : 0);
    const readInt8 = (dataView, offset) => (offset < dataView.byteLength ? dataView.getInt8(offset) : 0);
    const clampBleAxis = (value) => Math.max(-2, Math.min(2, value));
    const parseSensorTagMovement = (dataView, profile = sensorTag.activeProfile) => {
      if (profile?.parser === 'cc2541-sensortag') {
        return {
          x: clampBleAxis(readInt8(dataView, 0) / 64),
          y: clampBleAxis(readInt8(dataView, 1) / 64),
          z: clampBleAxis(readInt8(dataView, 2) / 64),
        };
      }
      const raw = dataView.byteLength >= 12
        ? { x: readInt16(dataView, 6), y: readInt16(dataView, 8), z: readInt16(dataView, 10) }
        : { x: readInt16(dataView, 0), y: readInt16(dataView, 2), z: readInt16(dataView, 4) };
      return {
        x: clampBleAxis(raw.x / 16384),
        y: clampBleAxis(raw.y / 16384),
        z: clampBleAxis(raw.z / 16384),
      };
    };
    const parseKeyfobAxisValue = (dataView) => clampBleAxis(readInt8(dataView, 0) / 64);
    const bleContextForSource = (source) => {
      if (String(source ?? 'active') === 'active') return activeBleContext();
      return Array.from(sensorTag.devices.values()).find((context) => String(context.slot) === String(source));
    };
    const bleMetricForAxes = (jointId, axes, axisSigns = sensorTag.axisSigns[jointId], context = activeBleContext()) => {
      const selectedAxes = normalizeBleAxisList(axes);
      if (!selectedAxes.length || !context) return 0;
      const signs = normalizeBleAxisSigns(axisSigns);
      const weighted = selectedAxes.map((axis) => (context.smooth[axis] || 0) * clampBleGain(sensorTag.gains[axis]) * signs[axis]);
      const signedSum = weighted.reduce((total, value) => total + value, 0);
      const magnitude = Math.sqrt(weighted.reduce((total, value) => total + value * value, 0)) / Math.sqrt(weighted.length);
      const firstNonZero = weighted.find((value) => Math.abs(value) > 0.000001) || 0;
      const sign = Math.sign(signedSum) || Math.sign(firstNonZero);
      return Math.max(-1, Math.min(1, magnitude * sign));
    };
    const bleValueForJoint = (jointId, axes, axisSigns = sensorTag.axisSigns[jointId], context = activeBleContext()) => {
      const range = limits[jointId] || [-3.14, 3.14];
      const centered = bleMetricForAxes(jointId, axes, axisSigns, context);
      const mid = (range[0] + range[1]) / 2;
      const span = (range[1] - range[0]) * 0.42;
      return Math.max(range[0], Math.min(range[1], mid + centered * span));
    };
    const setCalibrationStatus = (text) => {
      document.getElementById('ble-calibration-status').textContent = text;
    };
    const calibrationLabel = (jointId) => {
      const row = bleRows.find((candidate) => candidate.jointId === jointId);
      return row ? row.label : jointId.toUpperCase();
    };
    const calibrationGuide = (jointId) => jointGuides[jointId] || { positive:'positivo', negative:'negativo', instruction:'mueve el SensorTag en la direccion positiva real', intent:'movimiento del joint' };
    const renderCalibrationReport = () => {
      const container = document.getElementById('ble-calibration-report');
      const results = sensorTag.calibration.results.slice(-8).reverse();
      container.innerHTML = results.length
        ? results.map((result) => '<div><strong>' + calibrationLabel(result.jointId) + '</strong> ' + result.axes.join('+').toUpperCase() + ' | gain ' + result.gainsText + ' | confidence ' + Math.round(result.confidence * 100) + '%</div>').join('')
        : '<div>No calibration profile recorded yet.</div>';
    };
    const axisAverage = (values) => values.reduce((total, value) => total + value, 0) / Math.max(values.length, 1);
    const analyzeCalibrationSamples = (samples) => {
      const usable = samples.slice(Math.min(4, Math.floor(samples.length * 0.12)));
      if (usable.length < 8) return { axes: [], signs: normalizeBleAxisSigns(), gains: {}, confidence: 0, reason: 'need-more-samples' };
      const stats = bleAxes.map((axis) => {
        const values = usable.map((sample) => sample.axes[axis] || 0);
        const first = axisAverage(values.slice(0, Math.max(3, Math.floor(values.length * 0.18))));
        const last = axisAverage(values.slice(-Math.max(3, Math.floor(values.length * 0.18))));
        const mean = axisAverage(values);
        const centered = values.map((value) => value - mean);
        const rms = Math.sqrt(axisAverage(centered.map((value) => value * value)));
        const min = Math.min(...values);
        const max = Math.max(...values);
        const span = max - min;
        const finalDelta = last - first;
        const energy = Math.max(Math.abs(finalDelta), span * 0.55, rms * 1.7);
        return { axis, energy, finalDelta, span, rms };
      }).sort((a, b) => b.energy - a.energy);
      const strongest = stats[0]?.energy || 0;
      const threshold = Math.max(0.018, strongest * 0.46);
      const selected = stats.filter((stat) => stat.energy >= threshold).slice(0, 2);
      if (!selected.length || strongest < 0.018) return { axes: [], signs: normalizeBleAxisSigns(), gains: {}, confidence: 0, reason: 'motion-too-small' };
      const signs = normalizeBleAxisSigns();
      const gains = {};
      selected.forEach((stat) => {
        signs[stat.axis] = Math.sign(stat.finalDelta) || 1;
        gains[stat.axis] = clampBleGain(0.78 / Math.max(stat.energy, 0.035));
      });
      const separation = selected.length > 1 ? Math.min(1, selected[1].energy / Math.max(strongest, 0.001)) : 0.35;
      const confidence = Math.max(0.15, Math.min(1, (strongest / 0.18) * (0.78 + separation * 0.22)));
      return { axes: selected.map((stat) => stat.axis), signs, gains, confidence, stats, reason: 'ok' };
    };
    const applyCalibrationResult = (jointId, result) => {
      if (!result.axes.length) return false;
      sensorTag.map[jointId] = { source:'active', axes:result.axes };
      sensorTag.axisSigns[jointId] = normalizeBleAxisSigns(result.signs);
      result.axes.forEach((axis) => {
        sensorTag.gains[axis] = clampBleGain(result.gains[axis]);
      });
      const gainsText = result.axes.map((axis) => axis.toUpperCase() + '=' + sensorTag.gains[axis].toFixed(1) + 'x' + (sensorTag.axisSigns[jointId][axis] < 0 ? ' inv' : '')).join(', ');
      sensorTag.calibration.results.push({ jointId, axes: result.axes, gainsText, confidence: result.confidence, updatedAt: new Date().toISOString() });
      saveBleMap();
      saveBleAxisSigns();
      saveBleGains();
      saveBleCalibrationProfile();
      renderBleGains();
      renderBleMap();
      renderCalibrationReport();
      return true;
    };
    const finishCalibrationWindow = () => {
      const calibration = sensorTag.calibration;
      const jointId = calibration.jointId;
      calibration.phase = 'finishing';
      const result = analyzeCalibrationSamples(calibration.samples);
      if (result.axes.length) {
        applyCalibrationResult(jointId, result);
        setCalibrationStatus('Saved ' + calibrationLabel(jointId) + ' -> ' + result.axes.join('+').toUpperCase() + '. Move the sensor again to control this HR.');
      } else {
        setCalibrationStatus('Calibration failed for ' + calibrationLabel(jointId) + ': motion was too small or noisy. Repeat with a wider movement.');
      }
      const next = calibration.queue.shift();
      if (next) {
        setTimeout(() => startCalibrationWindow(next, calibration.queue), 900);
        return;
      }
      calibration.active = false;
      calibration.phase = 'idle';
      calibration.jointId = '';
      calibration.samples = [];
      calibration.timer = null;
      calibration.prepareTimer = null;
    };
    const beginCalibrationRecording = () => {
      const calibration = sensorTag.calibration;
      const guide = calibrationGuide(calibration.jointId);
      calibration.phase = 'recording';
      calibration.startedAt = Date.now();
      calibration.samples = [];
      calibration.previewAt = 0;
      setCalibrationStatus('Recording ' + calibrationLabel(calibration.jointId) + ' (' + guide.intent + ') for ' + (calibration.durationMs / 1000).toFixed(1) + 's. ' + guide.instruction + '. Positive = ' + guide.positive + ', negative = ' + guide.negative + '.');
      calibration.timer = setTimeout(finishCalibrationWindow, calibration.durationMs);
    };
    const startCalibrationWindow = (jointId, queue = []) => {
      if (!state.connected) {
        setCalibrationStatus('Connect Modbus first so the robot can move during calibration.');
        return;
      }
      if (!sensorTag.connected) {
        setCalibrationStatus('Connect a BLE device, press Drive Robot on its card and wait for BLE live samples.');
        return;
      }
      if (sensorTag.calibration.timer) clearTimeout(sensorTag.calibration.timer);
      if (sensorTag.calibration.prepareTimer) clearTimeout(sensorTag.calibration.prepareTimer);
      sensorTag.calibration.active = true;
      sensorTag.calibration.phase = 'preparing';
      sensorTag.calibration.queue = [...queue];
      sensorTag.calibration.jointId = jointId;
      sensorTag.calibration.samples = [];
      sensorTag.calibration.previewAt = 0;
      const guide = calibrationGuide(jointId);
      setCalibrationStatus('Prepare ' + calibrationLabel(jointId) + ' (' + guide.intent + '). In ' + (sensorTag.calibration.prepareMs / 1000).toFixed(1) + 's move: ' + guide.instruction + '. Positive = ' + guide.positive + ', negative = ' + guide.negative + '.');
      sensorTag.calibration.prepareTimer = setTimeout(beginCalibrationRecording, sensorTag.calibration.prepareMs);
    };
    const recordCalibrationSample = () => {
      const calibration = sensorTag.calibration;
      if (!calibration.active || calibration.phase !== 'recording') return;
      calibration.samples.push({ t: Date.now() - calibration.startedAt, axes: { ...sensorTag.smooth } });
      const remaining = Math.max(0, calibration.durationMs - (Date.now() - calibration.startedAt));
      if (calibration.samples.length % 5 === 0) {
        setCalibrationStatus('Recording ' + calibrationLabel(calibration.jointId) + ': ' + (remaining / 1000).toFixed(1) + 's left, ' + calibration.samples.length + ' samples.');
      }
    };
    const publishCalibrationPreview = async () => {
      const calibration = sensorTag.calibration;
      if (!state.connected || !sensorTag.connected || !calibration.active || calibration.phase !== 'recording') return;
      if (Date.now() - calibration.previewAt < 120 || calibration.samples.length < 8) return;
      calibration.previewAt = Date.now();
      const result = analyzeCalibrationSamples(calibration.samples);
      if (!result.axes.length) return;
      await request('/write', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ jointId: calibration.jointId, value: bleValueForJoint(calibration.jointId, result.axes, result.signs) })
      }).catch(() => undefined);
      await refresh().catch(() => undefined);
    };
    const startCalibrationQueue = (jointIds) => {
      if (!jointIds.length) return;
      const [first, ...rest] = jointIds;
      startCalibrationWindow(first, rest);
    };
    const previewCalibrationGuide = () => {
      const jointId = document.getElementById('ble-calibration-joint').value;
      const guide = calibrationGuide(jointId);
      setCalibrationStatus(calibrationLabel(jointId) + ': +' + guide.positive + ' / -' + guide.negative + '. Para calibrar, pulsa Calibrate Selected HR y ' + guide.instruction + '.');
    };
    const clearCalibrationProfile = () => {
      if (sensorTag.calibration.timer) clearTimeout(sensorTag.calibration.timer);
      if (sensorTag.calibration.prepareTimer) clearTimeout(sensorTag.calibration.prepareTimer);
      sensorTag.calibration.active = false;
      sensorTag.calibration.phase = 'idle';
      sensorTag.calibration.queue = [];
      sensorTag.calibration.samples = [];
      sensorTag.calibration.results = [];
      sensorTag.map = Object.fromEntries(bleRows.map((row) => [row.jointId, { source:'active', axes:[] }]));
      sensorTag.axisSigns = Object.fromEntries(bleRows.map((row) => [row.jointId, normalizeBleAxisSigns()]));
      sensorTag.gains = { x:3, y:3, z:3 };
      localStorage.removeItem('assetForge.bleCalibrationProfile');
      localStorage.removeItem('assetForge.bleAxisMap');
      localStorage.removeItem('assetForge.bleAxisSigns');
      localStorage.removeItem('assetForge.bleAxisGains');
      renderBleGains();
      renderBleMap();
      renderCalibrationReport();
      setCalibrationStatus('Calibration cleared. Scales returned to 3.0x and HR mappings are empty.');
    };
    const publishBleAxes = async (sourceContext = activeBleContext()) => {
      if (sensorTag.calibration.active) {
        publishCalibrationPreview();
        return;
      }
      if (!state.connected || !sourceContext?.connected) return;
      if (Date.now() - (sourceContext.lastPublish || 0) < 90) return;
      sourceContext.lastPublish = Date.now();
      const mapped = bleRows
        .map((row) => ({ row, entry:normalizeBleMapEntry(sensorTag.map[row.jointId]) }))
        .filter(({ entry }) => entry.axes.length && bleContextForSource(entry.source)?.id === sourceContext.id);
      for (const row of mapped) {
        await request('/write', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ jointId: row.row.jointId, displayAddress: row.row.displayAddress, value: bleValueForJoint(row.row.jointId, row.entry.axes, sensorTag.axisSigns[row.row.jointId], sourceContext) })
        }).catch(() => undefined);
      }
      if (mapped.length) await refresh().catch(() => undefined);
    };
    const processBleAxes = (context, axes, rawHex = '') => {
      if (!context) return;
      if (context.firstNotificationTimer) {
        clearTimeout(context.firstNotificationTimer);
        context.firstNotificationTimer = null;
      }
      context.connected = true;
      context.lastSeenAt = Date.now();
      context.lastRawHex = rawHex;
      if (!context.baseline) context.baseline = axes;
      context.axes = axes;
      context.smooth = {
        x: context.smooth.x * 0.72 + (axes.x - context.baseline.x) * 0.28,
        y: context.smooth.y * 0.72 + (axes.y - context.baseline.y) * 0.28,
        z: context.smooth.z * 0.72 + (axes.z - context.baseline.z) * 0.28,
      };
      context.samples.push(Date.now());
      context.samples = context.samples.filter((sampleMs) => Date.now() - sampleMs < 1400);
      if (!sensorTag.activeDeviceId) sensorTag.activeDeviceId = context.id;
      if (context.id !== sensorTag.activeDeviceId) {
        renderBleDevices();
        publishBleAxes(context);
        return;
      }
      syncActiveBleContext();
      setBleStatus('BLE live', true);
      recordCalibrationSample();
      updateBleAxisUi();
      publishBleAxes(context);
    };
    const handleMovementNotification = (context, event) => {
      const dataView = event.target.value;
      processBleAxes(context, parseSensorTagMovement(dataView, context.profile), dataViewToHex(dataView));
    };
    const handleKeyfobAxisNotification = (context, axis, event) => {
      const dataView = event.target.value;
      context.keyfobAxes[axis] = parseKeyfobAxisValue(dataView);
      processBleAxes(context, { ...context.keyfobAxes }, axis + ':' + dataViewToHex(dataView));
    };
    const writeBleCharacteristic = async (characteristic, value) => {
      if (!characteristic?.writeValue || !Array.isArray(value)) return;
      await characteristic.writeValue(new Uint8Array(value));
    };
    const tryWriteBleCharacteristic = async (characteristic, value) => {
      try {
        await writeBleCharacteristic(characteristic, value);
        return true;
      } catch {
        return false;
      }
    };
    const trackBleNotification = async (context, characteristic, handler) => {
      characteristic.addEventListener('characteristicvaluechanged', handler);
      context.notificationHandlers.push({ characteristic, handler });
      if (!characteristic.startNotifications) return false;
      await characteristic.startNotifications();
      return true;
    };
    const clearBleRuntime = () => {
      clearBleContextRuntime(activeBleContext());
    };
    const startCombinedBlePolling = (context, data, profile) => {
      if (!data?.readValue) throw new Error('TI_BLE_DATA_NOT_READABLE');
      context.pollTimer = setInterval(async () => {
        const value = await data.readValue().catch(() => undefined);
        if (value) processBleAxes(context, parseSensorTagMovement(value, profile), dataViewToHex(value));
      }, 100);
    };
    const startKeyfobBlePolling = (context, axisCharacteristics) => {
      if (!bleAxes.every((axis) => axisCharacteristics[axis]?.readValue)) throw new Error('TI_KEYFOB_AXES_NOT_READABLE');
      context.pollTimer = setInterval(async () => {
        let updated = false;
        for (const axis of bleAxes) {
          const value = await axisCharacteristics[axis].readValue().catch(() => undefined);
          if (value) {
            context.keyfobAxes[axis] = parseKeyfobAxisValue(value);
            updated = true;
          }
        }
        if (updated) processBleAxes(context, { ...context.keyfobAxes }, 'keyfob:poll');
      }, 100);
    };
    const stopBleDevice = async (deviceId, options = {}) => {
      const context = sensorTag.devices.get(deviceId);
      if (!context) return;
      clearBleContextRuntime(context);
      context.connected = false;
      context.baseline = null;
      try {
        await writeBleCharacteristic(context.configCharacteristic, context.profile?.disableValue || [0x00]);
      } catch {
        // Best-effort disable; notification teardown still runs below.
      } finally {
        for (const characteristic of context.characteristics) {
          try {
            await characteristic?.stopNotifications?.();
          } catch {
            // The device may already be gone.
          }
        }
        context.device?.gatt?.disconnect?.();
      }
      sensorTag.devices.delete(deviceId);
      if (sensorTag.activeDeviceId === deviceId) {
        sensorTag.activeDeviceId = sensorTag.devices.keys().next().value || '';
        syncActiveBleContext();
      }
      renderBleDevices();
      updateBleAxisUi();
      renderBleMap();
      if (!options.quiet && sensorTag.activeDeviceId) setBleActiveDevice(sensorTag.activeDeviceId);
    };
    const stopBle = async (options = {}) => {
      const active = activeBleContext();
      if (active) await stopBleDevice(active.id, options);
      if (!sensorTag.devices.size && !options.quiet) {
        syncActiveBleContext();
        setBleStatus('BLE idle');
        document.getElementById('ble-device').textContent = 'no device';
      }
    };
    const stopAllBle = async () => {
      const ids = Array.from(sensorTag.devices.keys());
      for (const id of ids) await stopBleDevice(id, { quiet:true });
      sensorTag.activeDeviceId = '';
      syncActiveBleContext();
      renderBleDevices();
      updateBleAxisUi();
      renderBleMap();
      setBleStatus('BLE idle');
      document.getElementById('ble-device').textContent = 'no device';
    };
    const armBleSession = async (context, session) => {
      setBleStatus('BLE starting...');
      if (session.profile.parser === 'cc2541-keyfob') {
        let notified = false;
        for (const axis of bleAxes) {
          const handler = (event) => handleKeyfobAxisNotification(context, axis, event);
          notified = (await trackBleNotification(context, context.axisCharacteristics[axis], handler).catch(() => false)) || notified;
        }
        await tryWriteBleCharacteristic(session.period, session.profile.periodValue);
        await tryWriteBleCharacteristic(session.range, session.profile.rangeValue);
        const enabled = await tryWriteBleCharacteristic(session.config, session.profile.enableValue);
        if (!enabled && !notified && !bleAxes.every((axis) => context.axisCharacteristics[axis]?.readValue)) throw new Error('TI_KEYFOB_ENABLE_FAILED');
        if (!notified) startKeyfobBlePolling(context, context.axisCharacteristics);
      } else {
        const handler = (event) => handleMovementNotification(context, event);
        const notified = await trackBleNotification(context, session.data, handler).catch(() => false);
        await tryWriteBleCharacteristic(session.period, session.profile.periodValue);
        const enabled = await tryWriteBleCharacteristic(session.config, session.profile.enableValue);
        if (!enabled && !notified && !session.data?.readValue) throw new Error('TI_BLE_ENABLE_FAILED');
        if (!notified) startCombinedBlePolling(context, session.data, session.profile);
      }
      context.connected = true;
      context.firstNotificationTimer = setTimeout(() => {
        if (context.connected && !context.samples.length && context.id === sensorTag.activeDeviceId) setBleStatus('BLE starting no data yet');
      }, 5000);
    };
    const connectBle = async () => {
      if (!navigator.bluetooth) {
        setBleStatus('BLE unavailable');
        return;
      }
      let context = null;
      try {
        setBleStatus('BLE pairing...');
        const device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: allBleOptionalServices(),
        });
        document.getElementById('ble-device').textContent = device.name || device.id || 'TI BLE device';
        setBleStatus('BLE connecting GATT...');
        const server = await device.gatt.connect();
        setBleStatus('BLE discovering GATT...');
        let session = null;
        let lastError = null;
        for (const profile of selectedBleProfiles()) {
          try {
            session = await requireBleGattProfile(server, profile);
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!session) throw lastError || new Error('TI_BLE_PROFILE_NOT_FOUND');
        context = createBleDeviceContext(device, session);
        sensorTag.devices.set(context.id, context);
        sensorTag.activeDeviceId = context.id;
        device.addEventListener('gattserverdisconnected', () => {
          clearBleContextRuntime(context);
          context.connected = false;
          renderBleDevices();
          if (context.id === sensorTag.activeDeviceId) {
            syncActiveBleContext();
            setBleStatus('BLE disconnected');
          }
        });
        document.getElementById('ble-device').textContent = context.label + ' | ' + session.profile.label + ' | active';
        await armBleSession(context, session);
        syncActiveBleContext();
        renderBleDevices();
        renderBleMap();
        updateBleAxisUi();
      } catch (error) {
        if (context?.samples.length) {
          context.connected = true;
          syncActiveBleContext();
          renderBleDevices();
          renderBleMap();
          setBleStatus('BLE live', true);
          return;
        }
        if (context) {
          clearBleContextRuntime(context);
          sensorTag.devices.delete(context.id);
          if (sensorTag.activeDeviceId === context.id) sensorTag.activeDeviceId = sensorTag.devices.keys().next().value || '';
          syncActiveBleContext();
          renderBleDevices();
          renderBleMap();
        }
        setBleStatus(error?.message === 'TI_BLE_GATT_PROFILE_INCOMPLETE' ? 'BLE GATT incomplete' : 'BLE failed');
      }
    };
    const request = async (path, options = {}) => {
      if (!state.connected) throw new Error('controller-not-connected');
      const response = await fetch(state.baseUrl + path, options);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    };
    const ensureSessionId = () => {
      const existing = localStorage.getItem('assetForge.controllerSessionId');
      if (existing) return existing;
      const created = crypto.randomUUID ? crypto.randomUUID() : 'controller-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      localStorage.setItem('assetForge.controllerSessionId', created);
      return created;
    };
    const applyForcedPlatformDisconnect = () => {
      state.connected = false;
      state.baseUrl = '';
      state.registers = [];
      renderRegisters([]);
      renderMap([]);
      renderPackets([]);
      document.getElementById('platform-rx-status').textContent = 'Platform RX off';
      setConnectionUi(false, 'platform disconnected by 3D');
    };
    const reportClientSession = async (status = 'connected', options = {}) => {
      if (!state.baseUrl || !state.sessionId) return;
      const response = await fetch(state.baseUrl + '/client-session', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ id: state.sessionId, status, endpoint: state.baseUrl, manualConnect: Boolean(options.manualConnect) })
      }).catch(() => undefined);
      if (!response?.ok) return;
      const payload = await response.json().catch(() => undefined);
      if (status === 'connected' && payload?.clientAccepted === false) applyForcedPlatformDisconnect();
    };
    const disconnectPlatform = async () => {
      await reportClientSession('disconnected');
      state.connected = false;
      state.baseUrl = '';
      state.registers = [];
      state.lastGamepadWrite = 0;
      renderRegisters([]);
      renderMap([]);
      renderPackets([]);
      document.getElementById('platform-rx-status').textContent = 'Platform RX off';
      setConnectionUi(false, 'platform disconnected');
    };
    const write = async (jointId, value) => {
      if (!state.connected) return;
      await request('/write', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ jointId, value }) });
      await refresh();
    };
    const nudge = async (jointId, delta) => {
      if (!state.connected) return;
      await request('/nudge', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ jointId, delta }) });
      await refresh();
    };
    const refresh = async () => {
      if (!state.connected) return;
      const data = await request('/state', { cache:'no-store', headers:{'X-Asset-Forge-Client':'visual-controller', 'X-Asset-Forge-Session': state.sessionId} });
      if (data.clientAccepted === false) {
        applyForcedPlatformDisconnect();
        return;
      }
      state.registers = data.registers || [];
      setConnectionUi(true, data.cycleEnabled ? 'connected - cycle live' : 'connected - manual live');
      const reader = data.stateReaders?.[0];
      document.getElementById('platform-rx-status').textContent = reader ? 'Platform RX active ' + reader.ip : 'Platform RX off';
      renderRegisters(data.registers || []);
      renderMap(data.registers || []);
      renderPackets(data.modbusPackets || []);
    };
    const connect = async () => {
      const endpoint = endpointFromInputs();
      state.baseUrl = endpoint.baseUrl;
      state.sessionId = ensureSessionId();
      setConnectionUi(false, 'connecting...');
      try {
        state.connected = true;
        await reportClientSession('connected', { manualConnect: true });
        await refresh();
        localStorage.setItem('assetForge.controllerEndpoint', state.baseUrl);
      } catch (error) {
        state.connected = false;
        renderRegisters([]);
        renderMap([]);
        renderPackets([]);
        setConnectionUi(false, 'connection failed');
      }
    };
    const renderRegisters = (registers) => {
      const container = document.getElementById('registers');
      if (!registers.length) {
        container.innerHTML = '<div class="empty">Set IP and port, then press Connect to start manual communication.</div>';
        return;
      }
      container.innerHTML = registers.map((item) => {
        const range = limits[item.jointId] || [-3.14,3.14];
        return '<label class="row"><span>HR ' + item.displayAddress + ' ' + item.jointId.toUpperCase() + '</span>' +
          '<input type="range" min="' + range[0] + '" max="' + range[1] + '" step="0.01" value="' + item.value + '" data-slider="' + item.jointId + '">' +
          '<strong>' + Number(item.value).toFixed(2) + '</strong></label>';
      }).join('');
      document.querySelectorAll('[data-slider]').forEach((input) => {
        input.disabled = !state.connected;
        input.oninput = () => write(input.dataset.slider, Number(input.value));
      });
    };
    const renderMap = (registers) => {
      const map = document.getElementById('map');
      if (!registers.length) {
        map.innerHTML = '<div class="empty">No Modbus register map received yet.</div>';
        return;
      }
      map.innerHTML = registers.map((item) =>
        '<div class="map-row"><strong>HR ' + item.displayAddress + ' -> ' + item.jointName + '</strong><code>wire ' + item.address + ' | f32 BE high-low | ' + item.registers.map((v) => '0x' + v.toString(16).padStart(4, '0').toUpperCase()).join(' ') + '</code></div>'
      ).join('');
    };
    const renderPackets = (packets) => {
      const packetList = document.getElementById('packets');
      if (!packets.length) {
        packetList.innerHTML = '<div class="empty">No packets before manual connection.</div>';
        return;
      }
      packetList.innerHTML = packets.slice(-8).map((packet) =>
        '<div class="packet ' + packet.direction + '"><strong>' + packet.direction.toUpperCase() + ' | TID ' + packet.transactionId + ' | FC ' + packet.functionCode + '</strong><code>' + packet.hex + '</code></div>'
      ).join('');
    };
    document.querySelectorAll('[data-nudge]').forEach((button) => button.onclick = () => {
      const [jointId, delta] = button.dataset.nudge.split(':');
      nudge(jointId, Number(delta));
    });
    document.querySelectorAll('[data-write]').forEach((button) => button.onclick = () => {
      const [jointId, value] = button.dataset.write.split(':');
      write(jointId, Number(value));
    });
    document.getElementById('connect').onclick = connect;
    document.getElementById('disconnect-platform').onclick = disconnectPlatform;
    document.getElementById('ble-connect').onclick = connectBle;
    document.getElementById('ble-stop').onclick = stopBle;
    document.getElementById('ble-stop-all').onclick = stopAllBle;
    document.getElementById('ble-calibrate-all-top').onclick = () => startCalibrationQueue(bleRows.map((row) => row.jointId));
    document.getElementById('ble-calibrate-current').onclick = () => startCalibrationQueue([document.getElementById('ble-calibration-joint').value]);
    document.getElementById('ble-calibrate-all').onclick = () => startCalibrationQueue(bleRows.map((row) => row.jointId));
    document.getElementById('ble-calibration-clear').onclick = clearCalibrationProfile;
    document.getElementById('ble-calibration-joint').onchange = previewCalibrationGuide;
    const updateBleGain = (axis, value) => {
      if (!bleAxes.includes(axis)) return;
      sensorTag.gains[axis] = clampBleGain(value);
      renderBleGains();
      saveBleGains();
      saveBleCalibrationProfile();
    };
    document.querySelectorAll('[data-ble-gain]').forEach((input) => {
      input.oninput = (event) => updateBleGain(input.dataset.bleGain, event.target.value);
    });
    document.querySelectorAll('[data-ble-gain-range]').forEach((input) => {
      input.oninput = (event) => updateBleGain(input.dataset.bleGainRange, event.target.value);
    });
    document.getElementById('controller-ip').addEventListener('keydown', (event) => { if (event.key === 'Enter') connect(); });
    document.getElementById('controller-port').addEventListener('keydown', (event) => { if (event.key === 'Enter') connect(); });
    document.getElementById('cycle').onclick = async () => { if (!state.connected) return; await request('/cycle', { method:'POST' }); await refresh(); };
    document.getElementById('home').onclick = async () => { if (!state.connected) return; await request('/home', { method:'POST' }); await refresh(); };
    document.addEventListener('keydown', (event) => {
      if (!state.connected) return;
      const map = { ArrowLeft:['j1',-0.08], ArrowRight:['j1',0.08], ArrowUp:['j2',0.08], ArrowDown:['j2',-0.08], a:['j3',-0.08], d:['j3',0.08], w:['j4',0.08], s:['j4',-0.08], q:['j5',-0.08], e:['j5',0.08], z:['j6',-0.08], x:['j6',0.08] };
      const action = map[event.key];
      if (action) { event.preventDefault(); nudge(action[0], action[1]); }
    });
    const pollGamepad = () => {
      const pad = state.connected && navigator.getGamepads ? navigator.getGamepads()[0] : undefined;
      if (pad && Date.now() - state.lastGamepadWrite > 120) {
        const axes = pad.axes || [];
        const moves = [['j1', axes[0]], ['j2', -axes[1]], ['j3', axes[2]], ['j4', -axes[3]]].filter((entry) => Math.abs(entry[1] || 0) > 0.18);
        if (moves.length) {
          state.lastGamepadWrite = Date.now();
          const [jointId, axis] = moves[0];
          nudge(jointId, axis * 0.05);
        }
        if (pad.buttons?.[4]?.pressed) nudge('j5', -0.05);
        if (pad.buttons?.[5]?.pressed) nudge('j5', 0.05);
        if (pad.buttons?.[6]?.pressed) nudge('j6', -0.04);
        if (pad.buttons?.[7]?.pressed) nudge('j6', 0.04);
      }
      requestAnimationFrame(pollGamepad);
    };
    renderRegisters([]);
    renderMap([]);
    renderPackets([]);
    loadBleMap();
    loadBleAxisSigns();
    loadBleGains();
    loadBleCalibrationProfile();
    renderBleMap();
    renderCalibrationReport();
    previewCalibrationGuide();
    updateBleAxisUi();
    setConnectionUi(false, 'not connected');
    window.addEventListener('beforeunload', () => {
      if (!state.baseUrl || !state.sessionId) return;
      navigator.sendBeacon?.(state.baseUrl + '/client-session', new Blob([JSON.stringify({ id: state.sessionId, status: 'disconnected', endpoint: state.baseUrl })], { type: 'application/json' }));
    });
    setInterval(() => { if (state.connected) reportClientSession('connected'); }, 2500);
    setInterval(() => { if (state.connected) refresh().catch(() => setConnectionUi(false, 'connection lost')); }, 500);
    requestAnimationFrame(pollGamepad);
  </script>
</body>
</html>`;

const send = (response, status, body, contentType = 'application/json') => {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Asset-Forge-Client, X-Asset-Forge-Session',
  });
  response.end(payload);
};

export const createVisualControllerServer = (state = new VisualModbusState()) => {
  const resolveEndpoint = (serverInstance) => {
    const address = serverInstance.address();
    const endpointHost = typeof address === 'object' && address ? localDisplayHost(address.address) : '127.0.0.1';
    const endpointPort = typeof address === 'object' && address ? address.port : 8765;
    return {
      host: endpointHost,
      port: String(endpointPort),
      stateUrl: `http://${endpointHost}:${endpointPort}/state`,
      writeUrl: `http://${endpointHost}:${endpointPort}/write`,
    };
  };
  const server = http.createServer(async (request, response) => {
    const path = parseUrl(request.url ?? '/').pathname;
    try {
      if (request.method === 'OPTIONS') return send(response, 200, { ok: true });
      if (request.method === 'GET' && path === '/') {
        return send(response, 200, controllerHtml(resolveEndpoint(server)), 'text/html; charset=utf-8');
      }
      if (request.method === 'GET' && path === '/health') {
        return send(
          response,
          200,
          state.health({
            controllerEndpoint: resolveEndpoint(server),
            clientId: request.headers['x-asset-forge-session'],
            clientIp: request.socket.remoteAddress,
            clientPort: request.socket.remotePort,
          }),
        );
      }
      if (request.method === 'POST' && path === '/client-session') {
        const body = await readJsonBody(request);
        const sessionResult = state.registerClient(body, {
          clientIp: request.socket.remoteAddress,
          clientPort: request.socket.remotePort,
          browserInfo: request.headers[browserInfoHeaderName],
        });
        return send(response, 200, { ...state.health({ controllerEndpoint: resolveEndpoint(server) }), clientId: sessionResult.id, clientAccepted: sessionResult.accepted });
      }
      if (request.method === 'GET' && path === '/state') {
        state.registerStateReader({
          readerKind: request.headers['x-asset-forge-client'] === 'platform-3d' ? 'platform-3d' : 'other',
          readerId: request.headers['x-asset-forge-session'],
          clientIp: request.socket.remoteAddress,
          clientPort: request.socket.remotePort,
        });
        return send(
          response,
          200,
          state.snapshot({
            controllerEndpoint: resolveEndpoint(server),
            clientId: request.headers['x-asset-forge-session'],
            clientIp: request.socket.remoteAddress,
            clientPort: request.socket.remotePort,
          }),
        );
      }
      if (request.method === 'POST' && path === '/cycle') {
        state.setCycle(true);
        return send(response, 200, { ok: true, cycleEnabled: true });
      }
      if (request.method === 'POST' && path === '/home') {
        state.home();
        return send(response, 200, { ok: true, cycleEnabled: false });
      }
      if (request.method === 'POST' && path === '/write') {
        const body = await readJsonBody(request);
        const result = state.write(body.displayAddress ?? body.jointId ?? body.signalId, Number(body.value));
        return send(response, 200, { ok: true, ...result });
      }
      if (request.method === 'POST' && path === '/nudge') {
        const body = await readJsonBody(request);
        const result = state.nudge(body.displayAddress ?? body.jointId ?? body.signalId, Number(body.delta));
        return send(response, 200, { ok: true, ...result });
      }
      return send(response, 404, { ok: false, error: 'not-found' });
    } catch (error) {
      return send(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return server;
};

const selfTest = async () => {
  const state = new VisualModbusState();
  state.write('40103', 1.25);
  const snapshot = state.snapshot();
  if (snapshot.registers[1].jointId !== 'j2') throw new Error('HR 40103 must map to j2.');
  if (Math.abs(snapshot.registers[1].value - 1.25) > 0.0001) throw new Error('Register write was not applied.');
  if (snapshot.registers[1].registers.length !== 2) throw new Error('f32 register must use two words.');
  if (snapshot.modbusPackets[0].functionCode !== 3) throw new Error('Expected Modbus function code 03.');
  if (!snapshot.modbusPackets[1].decoded.includes('0x')) throw new Error('Expected hex words in decoded packet.');
  console.log('visual modbus controller self-test passed');
};

const main = async () => {
  const args = new Set(process.argv.slice(2));
  if (args.has('--self-test')) {
    await selfTest();
    return;
  }
  const portArg = process.argv.find((arg) => arg.startsWith('--port='));
  const hostArg = process.argv.find((arg) => arg.startsWith('--host='));
  const port = Number(portArg?.split('=')[1] ?? process.env.MODBUS_VISUAL_PORT ?? 8765);
  const host = hostArg?.split('=')[1] ?? process.env.MODBUS_VISUAL_HOST ?? '127.0.0.1';
  if (args.has('--fresh')) {
    const stopped = await stopListenersOnPort(port);
    if (stopped.length) console.log(`Stopped previous Modbus controller on port ${port}: PID ${stopped.join(', ')}`);
  }
  const state = new VisualModbusState();
  if (args.has('--cycle')) state.setCycle(true);
  const server = createVisualControllerServer(state);
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Close the previous controller or run: node scripts/modbus_visual_controller.mjs --port=8766`);
      process.exit(1);
    }
    throw error;
  });
  server.listen(port, host, () => {
    console.log(`Visual Modbus controller: http://${host}:${port}`);
    console.log('Open Digital Twin Scenario in the platform, then press Visual Controller.');
  });
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
