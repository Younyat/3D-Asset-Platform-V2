VAR
  Command AT %QW90 : UINT := 0;
  Status AT %QW91 : UINT := 0;
  ActiveStep AT %QW92 : UINT := 0;
  ElapsedMsOut AT %QW93 : UINT := 0;
  J1Raw AT %QW100 : INT := 0;
  J2Raw AT %QW101 : INT := -6109;
  J3Raw AT %QW102 : INT := 13090;
  J4Raw AT %QW103 : INT := 8727;
  J5Raw AT %QW104 : INT := 0;
  J6Raw AT %QW105 : INT := 0;
  CycleTimer : TON;
  TimerEnabled : BOOL := FALSE;
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
  ElapsedMsOut := 0;
  J1Deg := INT_TO_REAL(J1Raw) / DegToRadScaled;
  J2Deg := INT_TO_REAL(J2Raw) / DegToRadScaled;
  J3Deg := INT_TO_REAL(J3Raw) / DegToRadScaled;
  J4Deg := INT_TO_REAL(J4Raw) / DegToRadScaled;
  J5Deg := INT_TO_REAL(J5Raw) / DegToRadScaled;
  J6Deg := INT_TO_REAL(J6Raw) / DegToRadScaled;
ELSE
  Status := 1;

  IF ResetTimer THEN
    TimerEnabled := FALSE;
    ResetTimer := FALSE;
  ELSE
    TimerEnabled := TRUE;
  END_IF;

  CycleTimer(IN := TimerEnabled, PT := T#18s);
  ElapsedMs := TIME_TO_DINT(CycleTimer.ET);
  IF ElapsedMs > 18000 THEN ElapsedMs := 18000; END_IF;
  ElapsedMsOut := DINT_TO_UINT(ElapsedMs);

  IF ElapsedMs < 3000 THEN
    ActiveStep := 1;
    SegmentStartMs := 0;
    SegmentDurationMs := 3000;
  ELSIF ElapsedMs < 6000 THEN
    ActiveStep := 2;
    SegmentStartMs := 3000;
    SegmentDurationMs := 3000;
  ELSIF ElapsedMs < 9000 THEN
    ActiveStep := 3;
    SegmentStartMs := 6000;
    SegmentDurationMs := 3000;
  ELSIF ElapsedMs < 12000 THEN
    ActiveStep := 4;
    SegmentStartMs := 9000;
    SegmentDurationMs := 3000;
  ELSIF ElapsedMs < 15000 THEN
    ActiveStep := 5;
    SegmentStartMs := 12000;
    SegmentDurationMs := 3000;
  ELSE
    ActiveStep := 6;
    SegmentStartMs := 15000;
    SegmentDurationMs := 3000;
  END_IF;

  P := DINT_TO_REAL(ElapsedMs - SegmentStartMs) / DINT_TO_REAL(SegmentDurationMs);
  IF P < 0.0 THEN P := 0.0; END_IF;
  IF P > 1.0 THEN P := 1.0; END_IF;
  P := P * P * (3.0 - (2.0 * P));

  IF ActiveStep = 1 THEN
    J1Deg := 0.0 + ((-150.0 - 0.0) * P);
    J2Deg := -35.0 + ((-75.0 - (-35.0)) * P);
    J3Deg := 75.0 + ((110.0 - 75.0) * P);
    J4Deg := 50.0 + ((-90.0 - 50.0) * P);
    J5Deg := 0.0 + ((-80.0 - 0.0) * P);
    J6Deg := 0.0 + ((-160.0 - 0.0) * P);
  ELSIF ActiveStep = 2 THEN
    J1Deg := -150.0;
    J2Deg := -75.0 + ((70.0 - (-75.0)) * P);
    J3Deg := 110.0 + ((145.0 - 110.0) * P);
    J4Deg := -90.0 + ((120.0 - (-90.0)) * P);
    J5Deg := -80.0 + ((100.0 - (-80.0)) * P);
    J6Deg := -160.0 + ((160.0 - (-160.0)) * P);
  ELSIF ActiveStep = 3 THEN
    J1Deg := -150.0 + ((150.0 - (-150.0)) * P);
    J2Deg := 70.0 + ((20.0 - 70.0) * P);
    J3Deg := 145.0 + ((40.0 - 145.0) * P);
    J4Deg := 120.0 + ((-130.0 - 120.0) * P);
    J5Deg := 100.0 + ((-110.0 - 100.0) * P);
    J6Deg := 160.0 + ((-170.0 - 160.0) * P);
  ELSIF ActiveStep = 4 THEN
    J1Deg := 150.0;
    J2Deg := 20.0 + ((-100.0 - 20.0) * P);
    J3Deg := 40.0 + ((130.0 - 40.0) * P);
    J4Deg := -130.0 + ((140.0 - (-130.0)) * P);
    J5Deg := -110.0 + ((120.0 - (-110.0)) * P);
    J6Deg := -170.0 + ((170.0 - (-170.0)) * P);
  ELSIF ActiveStep = 5 THEN
    J1Deg := 150.0 + ((-110.0 - 150.0) * P);
    J2Deg := -100.0 + ((80.0 - (-100.0)) * P);
    J3Deg := 130.0 + ((25.0 - 130.0) * P);
    J4Deg := 140.0 + ((-140.0 - 140.0) * P);
    J5Deg := 120.0 + ((-120.0 - 120.0) * P);
    J6Deg := 170.0 + ((-165.0 - 170.0) * P);
  ELSE
    J1Deg := -110.0 + ((0.0 - (-110.0)) * P);
    J2Deg := 80.0 + ((-35.0 - 80.0) * P);
    J3Deg := 25.0 + ((75.0 - 25.0) * P);
    J4Deg := -140.0 + ((50.0 - (-140.0)) * P);
    J5Deg := -120.0 + ((0.0 - (-120.0)) * P);
    J6Deg := -165.0 + ((0.0 - (-165.0)) * P);
  END_IF;

  IF CycleTimer.Q THEN ResetTimer := TRUE; END_IF;
END_IF;

IF J1Deg < -170.0 THEN J1Deg := -170.0; END_IF;
IF J1Deg > 170.0 THEN J1Deg := 170.0; END_IF;
IF J2Deg < -120.0 THEN J2Deg := -120.0; END_IF;
IF J2Deg > 120.0 THEN J2Deg := 120.0; END_IF;
IF J3Deg < -170.0 THEN J3Deg := -170.0; END_IF;
IF J3Deg > 170.0 THEN J3Deg := 170.0; END_IF;
IF J4Deg < -170.0 THEN J4Deg := -170.0; END_IF;
IF J4Deg > 170.0 THEN J4Deg := 170.0; END_IF;
IF J5Deg < -170.0 THEN J5Deg := -170.0; END_IF;
IF J5Deg > 170.0 THEN J5Deg := 170.0; END_IF;
IF J6Deg < -175.0 THEN J6Deg := -175.0; END_IF;
IF J6Deg > 175.0 THEN J6Deg := 175.0; END_IF;

J1Raw := REAL_TO_INT(J1Deg * DegToRadScaled);
J2Raw := REAL_TO_INT(J2Deg * DegToRadScaled);
J3Raw := REAL_TO_INT(J3Deg * DegToRadScaled);
J4Raw := REAL_TO_INT(J4Deg * DegToRadScaled);
J5Raw := REAL_TO_INT(J5Deg * DegToRadScaled);
J6Raw := REAL_TO_INT(J6Deg * DegToRadScaled);
