import { createVirtualPlcRuntime, executeVirtualPlcScan, resetVirtualPlcFault, setVirtualPlcInput } from './virtualPlcRuntime';

const equal = (actual: unknown, expected: unknown) => {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
};
const ok = (condition: boolean) => {
  if (!condition) throw new Error('Expected condition to be true.');
};

let plc = createVirtualPlcRuntime(1000);
plc = executeVirtualPlcScan(plc, { nowMs: 1020, runCommand: true });
equal(plc.mode, 'RUN');
equal(plc.outputs.motorEnable, true);
equal(plc.programState, 'AUTO');

plc = setVirtualPlcInput(plc, 'guardClosed', false);
plc = executeVirtualPlcScan(plc, { nowMs: 1040, runCommand: true });
equal(plc.mode, 'FAULT');
equal(plc.outputs.motorEnable, false);
ok(plc.alarms.some((alarm) => alarm.code === 'GUARD_OPEN' && alarm.active));

plc = resetVirtualPlcFault(plc, 1050);
equal(plc.mode, 'FAULT');
plc = setVirtualPlcInput(plc, 'guardClosed', true);
plc = resetVirtualPlcFault(plc, 1060);
equal(plc.mode, 'STOP');
ok(plc.alarms.every((alarm) => !alarm.active));

plc = executeVirtualPlcScan(plc, { nowMs: 1200, runCommand: true });
equal(plc.mode, 'FAULT');
ok(plc.scan.watchdogTrips > 0);

console.log('Virtual PLC runtime tests passed.');
