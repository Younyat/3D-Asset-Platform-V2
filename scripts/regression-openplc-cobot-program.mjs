import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../openplc/cobot-6dof-smart-demo/cobot_6dof_smart_demo.st', import.meta.url), 'utf8');
const required = [
  '%QW100', '%QW101', '%QW102', '%QW103', '%QW104', '%QW105',
  'T#10s', 'P := P * P * (3.0 - (2.0 * P))', 'ElapsedMs < 1400', 'ElapsedMs < 2400',
  'ElapsedMs < 3200', 'ElapsedMs < 5600', 'ElapsedMs < 7600',
];
for (const token of required) {
  if (!source.includes(token)) throw new Error(`OpenPLC program is missing ${token}`);
}
if (!source.trimStart().startsWith('VAR') || !source.includes('END_VAR')) throw new Error('OpenPLC POU must contain the declaration block followed by the program body');
if (/\bPROGRAM\b|\bCONFIGURATION\b|\bFUNCTION\b/.test(source)) throw new Error('OpenPLC Editor POU must not contain PROGRAM, CONFIGURATION or external FUNCTION wrappers');

const keys = [
  [0, [0, -35, 75, 50, 0, 0]],
  [1400, [-55, -10, 85, 25, 0, 0]],
  [2400, [-55, 15, 80, -5, 0, 0]],
  [3200, [-55, 15, 80, -5, 0, 90]],
  [5600, [50, -10, 85, 25, 0, 90]],
  [7600, [50, 15, 80, -5, 30, -90]],
  [10000, [0, -35, 75, 50, 0, 0]],
];
const smooth = (x) => x * x * (3 - 2 * x);
const sample = (timeMs) => {
  const endIndex = keys.findIndex(([time]) => time >= timeMs);
  if (endIndex <= 0) return keys[0][1];
  const [startTime, start] = keys[endIndex - 1];
  const [endTime, end] = keys[endIndex];
  const t = smooth((timeMs - startTime) / (endTime - startTime));
  return start.map((value, index) => value + (end[index] - value) * t);
};
for (const [time, expected] of keys) {
  const actual = sample(time);
  actual.forEach((value, index) => {
    if (Math.abs(value - expected[index]) > 1e-9) throw new Error(`Cycle mismatch at ${time} ms, J${index + 1}`);
    const encoded = Math.round(value * Math.PI / 180 * 10000);
    if (encoded < -32768 || encoded > 32767) throw new Error(`INT16 overflow at ${time} ms, J${index + 1}`);
  });
}

const amplified = await readFile(new URL('../openplc/cobot-6dof-smart-demo/cobot_6dof_smart_demo_amplified.st', import.meta.url), 'utf8');
const amplifiedRequired = [
  '%QW90', '%QW91', '%QW92', '%QW93',
  '%QW100', '%QW101', '%QW102', '%QW103', '%QW104', '%QW105',
  'Command = 0', 'Command = 2', 'T#18s',
  'P := P * P * (3.0 - (2.0 * P))',
  'J1Deg < -170.0', 'J2Deg < -120.0', 'J6Deg > 175.0',
];
for (const token of amplifiedRequired) {
  if (!amplified.includes(token)) throw new Error(`Amplified OpenPLC program is missing ${token}`);
}
if (!amplified.trimStart().startsWith('VAR') || !amplified.includes('END_VAR')) throw new Error('Amplified OpenPLC POU has an invalid declaration block');
if (/\bPROGRAM\b|\bCONFIGURATION\b|\bFUNCTION\b/.test(amplified)) throw new Error('Amplified OpenPLC POU contains an unsupported wrapper');

const amplifiedExtremes = [
  [-150, -75, 110, -90, -80, -160],
  [-150, 70, 145, 120, 100, 160],
  [150, 20, 40, -130, -110, -170],
  [150, -100, 130, 140, 120, 170],
  [-110, 80, 25, -140, -120, -165],
  [0, -35, 75, 50, 0, 0],
];
for (const pose of amplifiedExtremes) {
  pose.forEach((degrees, index) => {
    const encoded = Math.round(degrees * Math.PI / 180 * 10000);
    if (encoded < -32768 || encoded > 32767) throw new Error(`Amplified program INT16 overflow at J${index + 1}: ${degrees} degrees`);
  });
}

const iotProgram = await readFile(new URL('../openplc/cobot-6dof-smart-demo/cobot_6dof_iot_condition_monitoring.st', import.meta.url), 'utf8');
const iotRequired = [
  '%QW120', '%QW121', '%QW122', '%QW123', '%QW124', '%QW125', '%QW126', '%QW127',
  'TemperatureC >= 55.0', 'HumidityRH >= 85.0', 'GyroDps >= 220.0',
  'TemperatureC >= 45.0', 'HumidityRH >= 75.0', 'GyroDps >= 120.0',
  'SensorAgeMs > 2500', 'MotionScale := 0.55', 'ConditionState >= 2',
  'MotionIdleTimer', 'SensorPolicy = 1', 'AlarmCode := 5',
];
for (const token of iotRequired) {
  if (!iotProgram.includes(token)) throw new Error(`IoT condition-monitoring program is missing ${token}`);
}
if (!iotProgram.trimStart().startsWith('VAR') || !iotProgram.includes('END_VAR')) throw new Error('IoT OpenPLC POU has an invalid declaration block');
if (/\bPROGRAM\b|\bCONFIGURATION\b|\bFUNCTION\b/.test(iotProgram)) throw new Error('IoT OpenPLC POU contains an unsupported wrapper');

console.log('OpenPLC cobot programs regression passed: standard, amplified and IoT condition-monitoring profiles are valid.');
