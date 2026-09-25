export type VirtualPlcMode = 'STOP' | 'RUN' | 'FAULT';
export type VirtualPlcProgramState = 'IDLE' | 'HOMING' | 'AUTO' | 'FAULT';

export type VirtualPlcInputs = {
  emergencyStopHealthy: boolean;
  guardClosed: boolean;
  servoReady: boolean;
  automaticMode: boolean;
  startButton: boolean;
  stopButton: boolean;
  resetButton: boolean;
};

export type VirtualPlcOutputs = {
  motorEnable: boolean;
  cycleActive: boolean;
  homeRequest: boolean;
  faultLamp: boolean;
  runLamp: boolean;
};

export type VirtualPlcAlarm = {
  code: string;
  severity: 'warning' | 'fault';
  message: string;
  active: boolean;
  acknowledged: boolean;
  firstRaisedAtMs: number;
};

export type VirtualPlcRuntime = {
  mode: VirtualPlcMode;
  programState: VirtualPlcProgramState;
  inputs: VirtualPlcInputs;
  outputs: VirtualPlcOutputs;
  memory: {
    startLatch: boolean;
    safetyPermissive: boolean;
    communicationHealthy: boolean;
  };
  scan: {
    targetMs: number;
    lastMs: number;
    averageMs: number;
    maximumMs: number;
    cycleCount: number;
    watchdogLimitMs: number;
    watchdogTrips: number;
    lastScanAtMs: number;
  };
  alarms: VirtualPlcAlarm[];
};

export const createVirtualPlcRuntime = (nowMs = Date.now()): VirtualPlcRuntime => ({
  mode: 'STOP',
  programState: 'IDLE',
  inputs: {
    emergencyStopHealthy: true,
    guardClosed: true,
    servoReady: true,
    automaticMode: true,
    startButton: false,
    stopButton: false,
    resetButton: false,
  },
  outputs: {
    motorEnable: false,
    cycleActive: false,
    homeRequest: false,
    faultLamp: false,
    runLamp: false,
  },
  memory: {
    startLatch: false,
    safetyPermissive: true,
    communicationHealthy: true,
  },
  scan: {
    targetMs: 20,
    lastMs: 0,
    averageMs: 0,
    maximumMs: 0,
    cycleCount: 0,
    watchdogLimitMs: 100,
    watchdogTrips: 0,
    lastScanAtMs: nowMs,
  },
  alarms: [],
});

const upsertAlarm = (alarms: VirtualPlcAlarm[], code: string, message: string, active: boolean, nowMs: number): VirtualPlcAlarm[] => {
  const existing = alarms.find((alarm) => alarm.code === code);
  if (existing) {
    return alarms.map((alarm) => alarm.code === code ? { ...alarm, active, acknowledged: active ? false : alarm.acknowledged } : alarm);
  }
  if (!active) return alarms;
  return [...alarms, { code, message, severity: 'fault' as const, active: true, acknowledged: false, firstRaisedAtMs: nowMs }];
};

export const setVirtualPlcInput = <K extends keyof VirtualPlcInputs>(runtime: VirtualPlcRuntime, key: K, value: VirtualPlcInputs[K]): VirtualPlcRuntime => ({
  ...runtime,
  inputs: { ...runtime.inputs, [key]: value },
});

export const setVirtualPlcScanTarget = (runtime: VirtualPlcRuntime, targetMs: number): VirtualPlcRuntime => ({
  ...runtime,
  scan: { ...runtime.scan, targetMs: Math.max(5, Math.min(500, Math.round(targetMs))) },
});

export const resetVirtualPlcFault = (runtime: VirtualPlcRuntime, nowMs = Date.now()): VirtualPlcRuntime => {
  const safetyPermissive = runtime.inputs.emergencyStopHealthy && runtime.inputs.guardClosed && runtime.inputs.servoReady;
  if (!safetyPermissive) return runtime;
  return {
    ...runtime,
    mode: 'STOP',
    programState: 'IDLE',
    memory: { ...runtime.memory, startLatch: false, safetyPermissive },
    outputs: { ...runtime.outputs, motorEnable: false, cycleActive: false, faultLamp: false, runLamp: false },
    alarms: runtime.alarms.map((alarm) => ({ ...alarm, active: false, acknowledged: true })),
    scan: { ...runtime.scan, lastScanAtMs: nowMs },
  };
};

export const executeVirtualPlcScan = (
  runtime: VirtualPlcRuntime,
  options: { nowMs: number; runCommand?: boolean; communicationHealthy?: boolean },
): VirtualPlcRuntime => {
  const elapsedMs = Math.max(0, options.nowMs - runtime.scan.lastScanAtMs);
  const watchdogTrip = runtime.scan.cycleCount > 0 && elapsedMs > runtime.scan.watchdogLimitMs;
  const communicationHealthy = options.communicationHealthy ?? runtime.memory.communicationHealthy;
  const safetyPermissive = runtime.inputs.emergencyStopHealthy && runtime.inputs.guardClosed && runtime.inputs.servoReady;
  let alarms = upsertAlarm(runtime.alarms, 'E_STOP', 'Emergency stop circuit is open.', !runtime.inputs.emergencyStopHealthy, options.nowMs);
  alarms = upsertAlarm(alarms, 'GUARD_OPEN', 'Safety guard is open.', !runtime.inputs.guardClosed, options.nowMs);
  alarms = upsertAlarm(alarms, 'SERVO_NOT_READY', 'Servo drive is not ready.', !runtime.inputs.servoReady, options.nowMs);
  alarms = upsertAlarm(alarms, 'PLC_WATCHDOG', 'PLC scan exceeded the watchdog limit.', watchdogTrip, options.nowMs);
  alarms = upsertAlarm(alarms, 'COMMS_LOSS', 'Modbus communication is not healthy.', !communicationHealthy, options.nowMs);

  const faulted = !safetyPermissive || watchdogTrip;
  const stopRequested = runtime.inputs.stopButton || options.runCommand === false;
  const startRequested = runtime.inputs.startButton || options.runCommand === true;
  const startLatch = faulted || stopRequested ? false : runtime.memory.startLatch || startRequested;
  const mode: VirtualPlcMode = faulted ? 'FAULT' : startLatch ? 'RUN' : 'STOP';
  const programState: VirtualPlcProgramState = mode === 'FAULT' ? 'FAULT' : mode === 'RUN' ? (runtime.inputs.automaticMode ? 'AUTO' : 'HOMING') : 'IDLE';
  const cycleCount = runtime.scan.cycleCount + 1;
  const averageMs = cycleCount === 1 ? elapsedMs : runtime.scan.averageMs + (elapsedMs - runtime.scan.averageMs) / Math.min(cycleCount, 100);

  return {
    ...runtime,
    mode,
    programState,
    memory: { startLatch, safetyPermissive, communicationHealthy },
    outputs: {
      motorEnable: mode === 'RUN' && safetyPermissive,
      cycleActive: mode === 'RUN' && runtime.inputs.automaticMode,
      homeRequest: mode === 'RUN' && !runtime.inputs.automaticMode,
      faultLamp: mode === 'FAULT',
      runLamp: mode === 'RUN',
    },
    alarms,
    scan: {
      ...runtime.scan,
      lastMs: elapsedMs,
      averageMs,
      maximumMs: Math.max(runtime.scan.maximumMs, elapsedMs),
      cycleCount,
      watchdogTrips: runtime.scan.watchdogTrips + (watchdogTrip ? 1 : 0),
      lastScanAtMs: options.nowMs,
    },
    inputs: { ...runtime.inputs, startButton: false, stopButton: false, resetButton: false },
  };
};
