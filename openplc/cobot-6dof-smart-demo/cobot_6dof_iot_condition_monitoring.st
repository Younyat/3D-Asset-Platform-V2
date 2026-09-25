VAR
  Command AT %QW90 : UINT := 0;
  Status AT %QW91 : UINT := 0;
  ActiveStep AT %QW92 : UINT := 0;
  ElapsedMsOut AT %QW93 : UINT := 0;
  AlarmCode AT %QW94 : UINT := 0;
  ConditionState AT %QW95 : UINT := 3;
  SpeedPermille AT %QW96 : UINT := 0;
  J1Raw AT %QW100 : INT := 0;
  J2Raw AT %QW101 : INT := -6109;
  J3Raw AT %QW102 : INT := 13090;
  J4Raw AT %QW103 : INT := 8727;
  J5Raw AT %QW104 : INT := 0;
  J6Raw AT %QW105 : INT := 0;
  TemperatureCx100 AT %QW120 : INT := 0;
  HumidityRHx100 AT %QW121 : UINT := 0;
  GyroDpsx100 AT %QW122 : UINT := 0;
  SensorAgeMs AT %QW123 : UINT := 65535;
  SensorValid AT %QW124 : UINT := 0;
  SensorSequence AT %QW125 : UINT := 0;
  SensorQualityBits AT %QW126 : UINT := 0;
  SensorPolicy AT %QW127 : UINT := 1;
  CycleTimer : TON;
  MotionIdleTimer : TON;
  TimerEnabled : BOOL := FALSE;
  ResetTimer : BOOL := TRUE;
  ElapsedMs : DINT := 0;
  SegmentStartMs : DINT := 0;
  SegmentDurationMs : DINT := 1;
  P : REAL := 0.0;
  MotionScale : REAL := 1.0;
  TemperatureC : REAL := 0.0;
  HumidityRH : REAL := 0.0;
  GyroDps : REAL := 0.0;
  J1Deg : REAL := 0.0;
  J2Deg : REAL := -35.0;
  J3Deg : REAL := 75.0;
  J4Deg : REAL := 50.0;
  J5Deg : REAL := 0.0;
  J6Deg : REAL := 0.0;
  TargetJ1 : REAL := 0.0;
  TargetJ2 : REAL := -35.0;
  TargetJ3 : REAL := 75.0;
  TargetJ4 : REAL := 50.0;
  TargetJ5 : REAL := 0.0;
  TargetJ6 : REAL := 0.0;
  MotionPresent : BOOL := FALSE;
  DegToRadScaled : REAL := 174.5329;
END_VAR


TemperatureC := INT_TO_REAL(TemperatureCx100) / 100.0;
HumidityRH := UINT_TO_REAL(HumidityRHx100) / 100.0;
GyroDps := UINT_TO_REAL(GyroDpsx100) / 100.0;
MotionPresent := GyroDps >= 3.0;
MotionIdleTimer(IN := (SensorPolicy = 1) AND (NOT MotionPresent), PT := T#2s);

ConditionState := 0;
AlarmCode := 0;
MotionScale := 1.0;
SpeedPermille := 1000;

IF (SensorValid = 0) OR ((SensorQualityBits AND 1) = 0) OR (SensorAgeMs > 2500) THEN
  ConditionState := 3;
  AlarmCode := 4;
  MotionScale := 0.0;
  SpeedPermille := 0;
ELSIF (SensorPolicy = 1) AND ((SensorQualityBits AND 16) = 0) THEN
  ConditionState := 3;
  AlarmCode := 6;
  MotionScale := 0.0;
  SpeedPermille := 0;
ELSIF (SensorPolicy = 1) AND MotionIdleTimer.Q THEN
  ConditionState := 2;
  AlarmCode := 5;
  MotionScale := 0.0;
  SpeedPermille := 0;
ELSIF (TemperatureC >= 55.0) OR (HumidityRH >= 85.0) OR (GyroDps >= 220.0) THEN
  ConditionState := 2;
  MotionScale := 0.0;
  SpeedPermille := 0;
  IF TemperatureC >= 55.0 THEN
    AlarmCode := 1;
  ELSIF HumidityRH >= 85.0 THEN
    AlarmCode := 2;
  ELSE
    AlarmCode := 3;
  END_IF;
ELSIF (TemperatureC >= 45.0) OR (HumidityRH >= 75.0) OR (GyroDps >= 120.0) THEN
  ConditionState := 1;
  MotionScale := 0.55;
  SpeedPermille := 550;
END_IF;

IF Command = 2 THEN
  TimerEnabled := FALSE;
  ResetTimer := TRUE;
  Status := 2;
  ActiveStep := 0;
  ElapsedMsOut := 0;
  J1Deg := 0.0;
  J2Deg := -35.0;
  J3Deg := 75.0;
  J4Deg := 50.0;
  J5Deg := 0.0;
  J6Deg := 0.0;
ELSIF Command = 0 THEN
  TimerEnabled := FALSE;
  ResetTimer := TRUE;
  Status := 0;
  ActiveStep := 0;
  J1Deg := INT_TO_REAL(J1Raw) / DegToRadScaled;
  J2Deg := INT_TO_REAL(J2Raw) / DegToRadScaled;
  J3Deg := INT_TO_REAL(J3Raw) / DegToRadScaled;
  J4Deg := INT_TO_REAL(J4Raw) / DegToRadScaled;
  J5Deg := INT_TO_REAL(J5Raw) / DegToRadScaled;
  J6Deg := INT_TO_REAL(J6Raw) / DegToRadScaled;
ELSIF ConditionState >= 2 THEN
  TimerEnabled := FALSE;
  ResetTimer := TRUE;
  Status := 3;
  ActiveStep := 0;
ELSE
  Status := 1;
  IF ResetTimer THEN
    TimerEnabled := FALSE;
    ResetTimer := FALSE;
  ELSE
    TimerEnabled := TRUE;
  END_IF;

  CycleTimer(IN := TimerEnabled, PT := T#12s);
  ElapsedMs := TIME_TO_DINT(CycleTimer.ET);
  IF ElapsedMs > 12000 THEN ElapsedMs := 12000; END_IF;
  ElapsedMsOut := DINT_TO_UINT(ElapsedMs);

  IF ElapsedMs < 3000 THEN
    ActiveStep := 1; SegmentStartMs := 0; SegmentDurationMs := 3000;
    TargetJ1 := -90.0; TargetJ2 := -10.0; TargetJ3 := 105.0;
    TargetJ4 := 10.0; TargetJ5 := -45.0; TargetJ6 := -90.0;
  ELSIF ElapsedMs < 6000 THEN
    ActiveStep := 2; SegmentStartMs := 3000; SegmentDurationMs := 3000;
    TargetJ1 := 90.0; TargetJ2 := 40.0; TargetJ3 := 125.0;
    TargetJ4 := -70.0; TargetJ5 := 60.0; TargetJ6 := 120.0;
  ELSIF ElapsedMs < 9000 THEN
    ActiveStep := 3; SegmentStartMs := 6000; SegmentDurationMs := 3000;
    TargetJ1 := -55.0; TargetJ2 := -75.0; TargetJ3 := 45.0;
    TargetJ4 := 120.0; TargetJ5 := -80.0; TargetJ6 := -140.0;
  ELSE
    ActiveStep := 4; SegmentStartMs := 9000; SegmentDurationMs := 3000;
    TargetJ1 := 0.0; TargetJ2 := -35.0; TargetJ3 := 75.0;
    TargetJ4 := 50.0; TargetJ5 := 0.0; TargetJ6 := 0.0;
  END_IF;

  P := DINT_TO_REAL(ElapsedMs - SegmentStartMs) / DINT_TO_REAL(SegmentDurationMs);
  IF P < 0.0 THEN P := 0.0; END_IF;
  IF P > 1.0 THEN P := 1.0; END_IF;
  P := P * P * (3.0 - (2.0 * P));

  J1Deg := J1Deg + (((0.0 + ((TargetJ1 - 0.0) * MotionScale)) - J1Deg) * P);
  J2Deg := J2Deg + (((-35.0 + ((TargetJ2 - (-35.0)) * MotionScale)) - J2Deg) * P);
  J3Deg := J3Deg + (((75.0 + ((TargetJ3 - 75.0) * MotionScale)) - J3Deg) * P);
  J4Deg := J4Deg + (((50.0 + ((TargetJ4 - 50.0) * MotionScale)) - J4Deg) * P);
  J5Deg := J5Deg + (((0.0 + ((TargetJ5 - 0.0) * MotionScale)) - J5Deg) * P);
  J6Deg := J6Deg + (((0.0 + ((TargetJ6 - 0.0) * MotionScale)) - J6Deg) * P);

  IF CycleTimer.Q THEN ResetTimer := TRUE; END_IF;
END_IF;

J1Raw := REAL_TO_INT(J1Deg * DegToRadScaled);
J2Raw := REAL_TO_INT(J2Deg * DegToRadScaled);
J3Raw := REAL_TO_INT(J3Deg * DegToRadScaled);
J4Raw := REAL_TO_INT(J4Deg * DegToRadScaled);
J5Raw := REAL_TO_INT(J5Deg * DegToRadScaled);
J6Raw := REAL_TO_INT(J6Deg * DegToRadScaled);
