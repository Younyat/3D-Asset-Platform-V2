VAR
  Command AT %QW90 : UINT := 1;
  Status AT %QW91 : UINT := 1;
  ActiveStep AT %QW92 : UINT := 0;
  ElapsedMsOut AT %QW93 : UINT := 0;
  J1Raw AT %QW100 : INT := 0;
  J2Raw AT %QW101 : INT := -6109;
  J3Raw AT %QW102 : INT := 13090;
  J4Raw AT %QW103 : INT := 8727;
  J5Raw AT %QW104 : INT := 0;
  J6Raw AT %QW105 : INT := 0;
  CycleTimer : TON;
  TimerEnabled : BOOL := TRUE;
  ResetTimer : BOOL := FALSE;
  ElapsedMs : DINT := 0;
  SegmentStartMs : DINT := 0;
  SegmentDurationMs : DINT := 1;
  P : REAL := 0.0;
  J1Deg : REAL := 0.0;
  J2Deg : REAL := -35.0;
  J3Deg : REAL := 75.0;
  J4Deg : REAL := 50.0;
  J5Deg : REAL := 0.0;
  J6Deg : REAL := 0.0;
  DegToRadScaled : REAL := 174.5329;
END_VAR


IF Command = 2 THEN
  TimerEnabled := FALSE; Status := 2; ActiveStep := 0; ElapsedMsOut := 0;
  J1Deg := 0.0; J2Deg := -35.0; J3Deg := 75.0;
  J4Deg := 50.0; J5Deg := 0.0; J6Deg := 0.0;
ELSIF Command = 0 THEN
  TimerEnabled := FALSE; Status := 0; ActiveStep := 0;
  J1Deg := INT_TO_REAL(J1Raw) / DegToRadScaled;
  J2Deg := INT_TO_REAL(J2Raw) / DegToRadScaled;
  J3Deg := INT_TO_REAL(J3Raw) / DegToRadScaled;
  J4Deg := INT_TO_REAL(J4Raw) / DegToRadScaled;
  J5Deg := INT_TO_REAL(J5Raw) / DegToRadScaled;
  J6Deg := INT_TO_REAL(J6Raw) / DegToRadScaled;
ELSE
  Status := 1;
  IF ResetTimer THEN 
    TimerEnabled := FALSE; ResetTimer := FALSE;
  ELSE 
    TimerEnabled := TRUE;
  END_IF;
  
  CycleTimer(IN := TimerEnabled, PT := T#10s);
  ElapsedMs := TIME_TO_DINT(CycleTimer.ET);
  IF ElapsedMs > 10000 THEN ElapsedMs := 10000; END_IF;
  ElapsedMsOut := DINT_TO_UINT(ElapsedMs);

  IF ElapsedMs < 1400 THEN
    ActiveStep := 1; SegmentStartMs := 0; SegmentDurationMs := 1400;
  ELSIF ElapsedMs < 2400 THEN
    ActiveStep := 2; SegmentStartMs := 1400; SegmentDurationMs := 1000;
  ELSIF ElapsedMs < 3200 THEN
    ActiveStep := 3; SegmentStartMs := 2400; SegmentDurationMs := 800;
  ELSIF ElapsedMs < 5600 THEN
    ActiveStep := 4; SegmentStartMs := 3200; SegmentDurationMs := 2400;
  ELSIF ElapsedMs < 7600 THEN
    ActiveStep := 5; SegmentStartMs := 5600; SegmentDurationMs := 2000;
  ELSE
    ActiveStep := 6; SegmentStartMs := 7600; SegmentDurationMs := 2400;
  END_IF;

  IF SegmentDurationMs > 0 THEN
    P := DINT_TO_REAL(ElapsedMs - SegmentStartMs) / DINT_TO_REAL(SegmentDurationMs);
    IF P < 0.0 THEN P := 0.0; ELSIF P > 1.0 THEN P := 1.0; END_IF;
    P := P * P * (3.0 - (2.0 * P));
  ELSE
    P := 0.0;
  END_IF;

  IF ActiveStep = 1 THEN
    J1Deg := 0.0 + ((-55.0 - 0.0) * P);
    J2Deg := -35.0 + ((-10.0 - (-35.0)) * P);
    J3Deg := 75.0 + ((85.0 - 75.0) * P);
    J4Deg := 50.0 + ((25.0 - 50.0) * P);
    J5Deg := 0.0;
    J6Deg := 0.0;
  ELSIF ActiveStep = 2 THEN
    J1Deg := -55.0;
    J2Deg := -10.0 + ((15.0 - (-10.0)) * P);
    J3Deg := 85.0 + ((80.0 - 85.0) * P);
    J4Deg := 25.0 + ((-5.0 - 25.0) * P);
    J5Deg := 0.0;
    J6Deg := 0.0;
  ELSIF ActiveStep = 3 THEN
    J1Deg := -55.0;
    J2Deg := 15.0;
    J3Deg := 80.0;
    J4Deg := -5.0;
    J5Deg := 0.0;
    J6Deg := 0.0 + ((90.0 - 0.0) * P);
  ELSIF ActiveStep = 4 THEN
    J1Deg := -55.0 + ((50.0 - (-55.0)) * P);
    J2Deg := 15.0 + ((-10.0 - 15.0) * P);
    J3Deg := 80.0 + ((85.0 - 80.0) * P);
    J4Deg := -5.0 + ((25.0 - (-5.0)) * P);
    J5Deg := 0.0;
    J6Deg := 90.0;
  ELSIF ActiveStep = 5 THEN
    J1Deg := 50.0;
    J2Deg := -10.0 + ((15.0 - (-10.0)) * P);
    J3Deg := 85.0 + ((80.0 - 85.0) * P);
    J4Deg := 25.0 + ((-5.0 - 25.0) * P);
    J5Deg := 0.0 + ((30.0 - 0.0) * P);
    J6Deg := 90.0 + ((-90.0 - 90.0) * P);
  ELSE
    J1Deg := 50.0 + ((0.0 - 50.0) * P);
    J2Deg := 15.0 + ((-35.0 - 15.0) * P);
    J3Deg := 80.0 + ((75.0 - 80.0) * P);
    J4Deg := -5.0 + ((50.0 - (-5.0)) * P);
    J5Deg := 30.0 + ((0.0 - 30.0) * P);
    J6Deg := -90.0 + ((0.0 - (-90.0)) * P);
  END_IF;

  IF CycleTimer.Q THEN ResetTimer := TRUE; END_IF;
END_IF;

J1Raw := REAL_TO_INT(J1Deg * DegToRadScaled);
J2Raw := REAL_TO_INT(J2Deg * DegToRadScaled);
J3Raw := REAL_TO_INT(J3Deg * DegToRadScaled);
J4Raw := REAL_TO_INT(J4Deg * DegToRadScaled);
J5Raw := REAL_TO_INT(J5Deg * DegToRadScaled);
J6Raw := REAL_TO_INT(J6Deg * DegToRadScaled);
