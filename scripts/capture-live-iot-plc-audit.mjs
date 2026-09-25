import { createHash, randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.join('=') || true];
}));
const host = String(args.host ?? '127.0.0.1');
const port = Number(args.port ?? 502);
const unitId = Number(args.unit ?? 1);
const controllerUrl = String(args.controller ?? 'http://127.0.0.1:8765');
const intervalMs = Math.max(100, Number(args.interval ?? 250));
const countdownSeconds = Math.max(3, Number(args.countdown ?? 12));
const movementSeconds = Math.max(5, Number(args.movement ?? 15));
const recoverySeconds = Math.max(4, Number(args.recovery ?? 8));
const outputDirectory = resolve(String(args.output ?? 'docs/audits'));

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const signed16 = (word) => (word & 0x8000 ? word - 0x10000 : word);
const hex = (buffer) => Buffer.from(buffer).toString('hex').toUpperCase().match(/.{1,2}/g)?.join(' ') ?? '';
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const isoFile = (date) => date.toISOString().replace(/[:.]/g, '-');
const fixed = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '--';

const readHoldingRegisters = (address, quantity) => new Promise((resolveRead, rejectRead) => {
  const transactionId = randomInt(1, 0xffff);
  const pdu = Buffer.from([3, address >> 8, address & 0xff, quantity >> 8, quantity & 0xff]);
  const request = Buffer.concat([Buffer.from([transactionId >> 8, transactionId & 0xff, 0, 0, 0, pdu.length + 1, unitId]), pdu]);
  const socket = net.createConnection({ host, port });
  const chunks = [];
  const finish = (error, value) => {
    socket.removeAllListeners();
    socket.destroy();
    if (error) rejectRead(error); else resolveRead(value);
  };
  socket.setTimeout(1200);
  socket.on('connect', () => socket.write(request));
  socket.on('timeout', () => finish(new Error('Modbus TCP timeout')));
  socket.on('error', (error) => finish(error));
  socket.on('data', (chunk) => {
    chunks.push(chunk);
    const response = Buffer.concat(chunks);
    if (response.length < 9) return;
    const expected = 6 + response.readUInt16BE(4);
    if (response.length < expected) return;
    if (response.readUInt16BE(0) !== transactionId) return finish(new Error('Transaction ID mismatch'));
    if (response[6] !== unitId) return finish(new Error('Unit ID mismatch'));
    if ((response[7] & 0x80) !== 0) return finish(new Error(`Modbus exception ${response[8]}`));
    const byteCount = response[8];
    const registers = Array.from({ length: byteCount / 2 }, (_, index) => response.readUInt16BE(9 + index * 2));
    finish(undefined, {
      transactionId,
      functionCode: response[7],
      address,
      quantity,
      registers,
      requestHex: hex(request),
      responseHex: hex(response.subarray(0, expected)),
    });
  });
});

const writeHoldingRegisters = (address, values) => new Promise((resolveWrite, rejectWrite) => {
  const transactionId = randomInt(1, 0xffff);
  const payload = values.flatMap((word) => [word >> 8, word & 0xff]);
  const pdu = Buffer.from([16, address >> 8, address & 0xff, values.length >> 8, values.length & 0xff, payload.length, ...payload]);
  const request = Buffer.concat([Buffer.from([transactionId >> 8, transactionId & 0xff, 0, 0, 0, pdu.length + 1, unitId]), pdu]);
  const socket = net.createConnection({ host, port });
  const chunks = [];
  const finish = (error, value) => {
    socket.removeAllListeners();
    socket.destroy();
    if (error) rejectWrite(error); else resolveWrite(value);
  };
  socket.setTimeout(1200);
  socket.on('connect', () => socket.write(request));
  socket.on('timeout', () => finish(new Error('Modbus TCP write timeout')));
  socket.on('error', (error) => finish(error));
  socket.on('data', (chunk) => {
    chunks.push(chunk);
    const response = Buffer.concat(chunks);
    if (response.length < 12) return;
    const expected = 6 + response.readUInt16BE(4);
    if (response.length < expected) return;
    if (response.readUInt16BE(0) !== transactionId || response[7] !== 16) return finish(new Error('Invalid FC16 acknowledgement'));
    finish(undefined, { transactionId, functionCode: 16, address, quantity: values.length, values, requestHex: hex(request), responseHex: hex(response.subarray(0, expected)) });
  });
});

const readController = async () => {
  const response = await fetch(`${controllerUrl}/state`, {
    cache: 'no-store',
    headers: { 'X-Asset-Forge-Client': 'scientific-audit', 'X-Asset-Forge-Session': 'iot-plc-audit' },
    signal: AbortSignal.timeout(1600),
  });
  if (!response.ok) throw new Error(`Controller HTTP ${response.status}`);
  return response.json();
};

const decode = (frame) => {
  const at = (wire) => frame.registers[wire - 90] ?? 0;
  return {
    command: at(90), status: at(91), activeStep: at(92), elapsedMs: at(93),
    alarmCode: at(94), conditionState: at(95), speedPermille: at(96),
    jointsRad: [100, 101, 102, 103, 104, 105].map((wire) => signed16(at(wire)) / 10000),
    temperatureC: signed16(at(120)) / 100,
    humidityRh: at(121) / 100,
    gyroDps: at(122) / 100,
    sensorAgeMs: at(123), sensorValid: at(124), sensorSequence: at(125),
    qualityBits: at(126), sensorPolicy: at(127),
  };
};

const samples = [];
let previousHash = 'GENESIS';
const capture = async (phase) => {
  const capturedAtUtc = new Date().toISOString();
  const controller = await readController();
  const telemetry = controller.iotTelemetry ?? {};
  const sensorAgeMs = Math.min(65535, Math.max(0, Math.round(finite(telemetry.ageMs, 65535))));
  const telemetryValid = Boolean(telemetry.valid) && sensorAgeMs < 3000;
  const hasAcceleration = Boolean(telemetry.hasAcceleration);
  const hasGyroscope = Boolean(telemetry.hasGyroscope);
  const hasEnvironment = Boolean(telemetry.hasEnvironment);
  const hasMagnetometer = Boolean(telemetry.hasMagnetometer);
  const qualityBits = (telemetryValid ? 1 : 0) | (sensorAgeMs < 1000 ? 2 : 0) | (telemetry.source ? 4 : 0) | (hasAcceleration ? 8 : 0) | (hasGyroscope ? 16 : 0) | (hasEnvironment ? 32 : 0) | (hasMagnetometer ? 64 : 0);
  const signedWord = (value) => Math.round(Math.max(-32768, Math.min(32767, value))) & 0xffff;
  const writeWords = [
    signedWord((hasEnvironment ? finite(telemetry.temperatureC) : 0) * 100),
    Math.round(Math.max(0, Math.min(65535, (hasEnvironment ? finite(telemetry.humidityPercent) : 0) * 100))),
    Math.round(Math.max(0, Math.min(65535, (hasGyroscope ? finite(telemetry.gyroDps) : 0) * 100))),
    sensorAgeMs,
    telemetryValid ? 1 : 0,
    Number(telemetry.sequence ?? 0) & 0xffff,
    qualityBits,
  ];
  const writeFrame = await writeHoldingRegisters(120, writeWords);
  await sleep(20);
  const frame = await readHoldingRegisters(90, 38);
  const plc = decode(frame);
  const core = {
    index: samples.length,
    phase,
    capturedAtUtc,
    iot: {
      source: telemetry.source ?? '', sampleId: telemetry.sampleId ?? '', sequence: telemetry.sequence ?? 0,
      quality: telemetry.quality ?? '', ageMs: telemetry.ageMs ?? 65535,
      gyroDps: finite(telemetry.gyroDps), gyroX: finite(telemetry.gyroX), gyroY: finite(telemetry.gyroY), gyroZ: finite(telemetry.gyroZ),
      accelX: finite(telemetry.accelX), accelY: finite(telemetry.accelY), accelZ: finite(telemetry.accelZ),
      temperatureC: finite(telemetry.temperatureC), humidityPercent: finite(telemetry.humidityPercent),
      hasEnvironment: Boolean(telemetry.hasEnvironment), valid: Boolean(telemetry.valid),
    },
    gateway: {
      endpoint: controller.controllerEndpoint,
      platformReader: controller.stateReaders?.find((reader) => reader.kind === 'platform-3d') ?? null,
      connectedClients: controller.connectedClients?.length ?? 0,
    },
    modbus: { telemetryWrite: writeFrame, stateRead: { ...frame, registers: frame.registers } },
    plc,
    digitalTwin: {
      binding: 'kinematicState[J1..J6] = signed(%QW100..%QW105) / 10000 rad',
      jointValuesRad: plc.jointsRad,
      platformReaderObserved: Boolean(controller.stateReaders?.some((reader) => reader.kind === 'platform-3d')),
    },
  };
  const parentHash = previousHash;
  const hash = createHash('sha256').update(parentHash).update(JSON.stringify(core)).digest('hex');
  previousHash = hash;
  samples.push({ ...core, integrity: { previousHash: parentHash, hash } });
  return samples.at(-1);
};

const captureFor = async (phase, durationMs) => {
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    const started = Date.now();
    try { await capture(phase); } catch (error) {
      samples.push({ index: samples.length, phase, capturedAtUtc: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
    }
    await sleep(Math.max(0, intervalMs - (Date.now() - started)));
  }
};

const stats = (phase) => {
  const rows = samples.filter((sample) => sample.phase === phase && !sample.error);
  const values = (getter) => rows.map(getter).filter(Number.isFinite);
  const range = (array) => array.length ? { min: Math.min(...array), max: Math.max(...array), mean: array.reduce((sum, value) => sum + value, 0) / array.length } : { min: NaN, max: NaN, mean: NaN };
  return {
    count: rows.length,
    iotGyro: range(values((row) => row.iot.gyroDps)),
    plcGyro: range(values((row) => row.plc.gyroDps)),
    speed: range(values((row) => row.plc.speedPermille)),
    conditions: [...new Set(rows.map((row) => row.plc.conditionState))],
    alarms: [...new Set(rows.map((row) => row.plc.alarmCode))],
    policies: [...new Set(rows.map((row) => row.plc.sensorPolicy))],
    commands: [...new Set(rows.map((row) => row.plc.command))],
    platformObserved: rows.some((row) => row.digitalTwin.platformReaderObserved),
  };
};

const representativeSamples = () => {
  const selected = [];
  for (const phase of ['still-before', 'movement', 'still-after']) {
    const rows = samples.filter((sample) => sample.phase === phase && !sample.error);
    if (!rows.length) continue;
    selected.push(rows[0], rows[Math.floor(rows.length / 2)], rows.at(-1));
    const peak = rows.reduce((best, row) => row.iot.gyroDps > best.iot.gyroDps ? row : best, rows[0]);
    selected.push(peak);
  }
  return [...new Map(selected.map((sample) => [sample.index, sample])).values()].sort((a, b) => a.index - b.index);
};

const buildReport = (startedAt, finishedAt, jsonName) => {
  const before = stats('still-before');
  const moving = stats('movement');
  const after = stats('still-after');
  const validRows = samples.filter((sample) => !sample.error);
  const first = validRows[0];
  const environmentalAnomaly = validRows.some((row) => row.iot.temperatureC <= -39.9 && row.iot.humidityPercent === 0);
  const movementDetected = moving.iotGyro.max >= 3;
  const stillHoldObserved = [...before.conditions, ...after.conditions].includes(2) && [...before.alarms, ...after.alarms].includes(5);
  const autoObserved = validRows.some((row) => row.plc.command === 1);
  const jointChanged = validRows.some((row, index) => index > 0 && row.plc.jointsRad.some((value, joint) => Math.abs(value - validRows[index - 1].plc.jointsRad[joint]) > 0.0001));
  const rows = representativeSamples().map((sample) => `| ${sample.index} | ${sample.phase} | ${sample.capturedAtUtc} | ${sample.iot.sampleId} | ${fixed(sample.iot.gyroDps)} | ${fixed(sample.plc.gyroDps)} | ${sample.plc.sensorAgeMs} | ${sample.plc.conditionState} | ${sample.plc.alarmCode} | ${sample.plc.speedPermille} | ${sample.plc.jointsRad.map((value) => fixed(value, 3)).join(', ')} | ${sample.modbus.telemetryWrite.transactionId} / ${sample.modbus.stateRead.transactionId} |`).join('\n');
  const phaseRow = (name, data) => `| ${name} | ${data.count} | ${fixed(data.iotGyro.min)} / ${fixed(data.iotGyro.mean)} / ${fixed(data.iotGyro.max)} | ${fixed(data.plcGyro.min)} / ${fixed(data.plcGyro.mean)} / ${fixed(data.plcGyro.max)} | ${data.conditions.join(', ')} | ${data.alarms.join(', ')} | ${data.speed.min}..${data.speed.max} |`;
  return `# Auditoria IoT -> Modbus -> OpenPLC -> Robot -> Gemelo digital

## Identificacion

| Campo | Valor |
| --- | --- |
| Inicio UTC | ${startedAt.toISOString()} |
| Fin UTC | ${finishedAt.toISOString()} |
| IoT observado | ${first?.iot.source || 'No identificado'} |
| Controlador IoT | ${controllerUrl} |
| OpenPLC Modbus TCP | ${host}:${port}, Unit ID ${unitId} |
| Periodo de muestreo nominal | ${intervalMs} ms |
| Muestras totales / validas | ${samples.length} / ${validRows.length} |
| Evidencia cruda | [${jsonName}](./${jsonName}) |
| Hash final SHA-256 | \`${previousHash}\` |

## Arquitectura observada

\`\`\`mermaid
flowchart LR
  A[CC2650 SensorTag\nBLE GATT] -->|XYZ, gyro, environment\nsampleId + sequence| B[Digital Twin Modbus Controller\n127.0.0.1:8765]
  B -->|HTTP /state\ntelemetria con freshness| C[3D Asset Platform]
  C -->|Modbus TCP FC16\n%QW120..126| D[OpenPLC Runtime\n127.0.0.1:${port} Unit ${unitId}]
  D -->|Programa ST\npolitica %QW127| E[Estado PLC\n%QW94..96]
  D -->|%QW100..105\nINT16 rad x10000| F[Robot fisico simulado]
  C -->|Modbus TCP FC03\n%QW90..127| D
  C -->|decode / 10000| G[Gemelo digital 3D\nkinematicState J1..J6]
\`\`\`

## Mapa Modbus verificado

| Wire OpenPLC | HR convencional | Semantica | Codificacion |
| ---: | ---: | --- | --- |
| %QW90 | 40091 | Command | 0 Manual/Hold, 1 Auto, 2 Home |
| %QW91..93 | 40092..40094 | Status, paso y tiempo | UINT16 |
| %QW94..96 | 40095..40097 | AlarmCode, ConditionState, SpeedPermille | UINT16 |
| %QW100..105 | 40101..40106 | J1..J6 | INT16, rad x10000 |
| %QW120 | 40121 | Temperatura | INT16, grados C x100 |
| %QW121 | 40122 | Humedad | UINT16, %RH x100 |
| %QW122 | 40123 | Magnitud giroscopio | UINT16, grados/s x100 |
| %QW123..126 | 40124..40127 | Age, valid, sequence, quality bits | UINT16 |
| %QW127 | 40128 | SensorPolicy | 0 condition monitor, 1 motion permit |

Las direcciones de la columna HR usan notacion humana 40001-based. Las tramas utilizan direcciones wire 0-based. La captura ejecuta FC03 sobre wire 90 con 38 registros y conserva request/response hexadecimal y Transaction ID en el JSON.

## Resultados por fase

| Fase | n | IoT gyro min/media/max | PLC gyro min/media/max | ConditionState | AlarmCode | SpeedPermille |
| --- | ---: | --- | --- | --- | --- | --- |
${phaseRow('Quieto inicial', before)}
${phaseRow('Movimiento manual', moving)}
${phaseRow('Quieto final', after)}

## Evidencia representativa

| # | Fase | UTC | sampleId BLE | gyro IoT | %QW122 | age ms | state | alarm | speed | J1..J6 rad | TID FC16 / FC03 |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
${rows}

## Evaluacion causal

| Hipotesis verificable | Resultado | Evidencia |
| --- | --- | --- |
| El IoT entrega muestras trazables | ${validRows.some((row) => row.iot.sampleId && row.iot.quality === 'GOOD') ? 'PASS' : 'FAIL'} | sampleId, sequence, timestamps y quality incluidos por muestra |
| El movimiento supera el umbral de 3 grados/s | ${movementDetected ? 'PASS' : 'FAIL'} | pico IoT ${fixed(moving.iotGyro.max)} grados/s |
| OpenPLC esta en Motion Permit | ${validRows.every((row) => row.plc.sensorPolicy === 1) ? 'PASS' : 'FAIL'} | %QW127 observado: ${[...new Set(validRows.map((row) => row.plc.sensorPolicy))].join(', ')} |
| OpenPLC esta en Auto | ${autoObserved ? 'PASS' : 'FAIL'} | %QW90 observado: ${[...new Set(validRows.map((row) => row.plc.command))].join(', ')} |
| Quietud produce HOLD por alarma 5 | ${stillHoldObserved ? 'PASS' : 'FAIL'} | ConditionState y AlarmCode de fases quietas |
| Joints PLC reaccionan | ${jointChanged ? 'PASS' : 'FAIL'} | cambios observados en %QW100..105 |
| Plataforma 3D consume el controlador | ${validRows.some((row) => row.digitalTwin.platformReaderObserved) ? 'PASS' : 'FAIL'} | lector platform-3d observado en /state |
| Gemelo usa el mismo vector articular | ${validRows.some((row) => row.digitalTwin.platformReaderObserved) ? 'PASS por contrato observado' : 'NO OBSERVADO'} | kinematicState = signed(%QW100..105)/10000; valores conservados en cada muestra |

## Integridad y trazabilidad

Cada muestra incluye la trama Modbus TCP FC16 de escritura, la trama FC03 de lectura, valores crudos, decodificacion, identidad BLE y un hash SHA-256 encadenado con la muestra anterior. El hash final permite detectar cambios posteriores en la evidencia. El fichero JSON es la fuente primaria; este Markdown es su interpretacion.

## Limitaciones y anomalias

- ${environmentalAnomaly ? '**Anomalia ambiental detectada:** el CC2650 publico -40 C y 0 %RH. Esos valores son sentinelas/no plausibles y no deben usarse para decisiones industriales hasta corregir o calibrar el decoder GATT.' : 'No se detecto el patron sentinela -40 C / 0 %RH durante esta captura.'}
- La reaccion visual se audita mediante el lector vivo \`platform-3d\` y el vector exacto aplicado a \`kinematicState\`. Una medicion metrologica del render requeriria instrumentar matrices del canvas o captura de video sincronizada.
- Esta es una demostracion de laboratorio. No acredita seguridad funcional, SIL/PL, parada segura ni control de una maquina fisica.
`;
};

const startedAt = new Date();
await mkdir(outputDirectory, { recursive: true });
const initial = await capture('preflight');
if (initial.plc.sensorPolicy !== 1) throw new Error(`Preflight failed: %QW127=${initial.plc.sensorPolicy}. Select Motion permit demo first.`);
if (initial.plc.command !== 1) throw new Error(`Preflight failed: %QW90=${initial.plc.command}. Select Auto first.`);
console.log(`PREFLIGHT PASS | ${initial.iot.source} | sample ${initial.iot.sampleId} | OpenPLC ${host}:${port} | policy=${initial.plc.sensorPolicy} | command=${initial.plc.command}`);
console.log(`KEEP SENSOR STILL | baseline starts now for ${countdownSeconds}s`);
await captureFor('still-before', countdownSeconds * 1000);
console.log(`MOVE SENSOR NOW | move it continuously and clearly for ${movementSeconds}s`);
await captureFor('movement', movementSeconds * 1000);
console.log(`STOP MOVING NOW | keep it still for ${recoverySeconds}s`);
await captureFor('still-after', recoverySeconds * 1000);
const finishedAt = new Date();
const stem = `iot-openplc-audit-${isoFile(startedAt)}`;
const jsonName = `${stem}.json`;
const mdName = `${stem}.md`;
const evidence = { schemaVersion: 1, startedAtUtc: startedAt.toISOString(), finishedAtUtc: finishedAt.toISOString(), endpoint: { controllerUrl, host, port, unitId }, intervalMs, finalHash: previousHash, samples };
await writeFile(resolve(outputDirectory, jsonName), JSON.stringify(evidence, null, 2), 'utf8');
await writeFile(resolve(outputDirectory, mdName), buildReport(startedAt, finishedAt, jsonName), 'utf8');
console.log(`AUDIT COMPLETE | ${resolve(outputDirectory, mdName)}`);
console.log(`RAW EVIDENCE | ${resolve(outputDirectory, jsonName)}`);
