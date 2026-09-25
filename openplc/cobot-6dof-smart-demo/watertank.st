  VAR
    openOutletValve : BOOL AT %QX0.1;
    openInletValve : BOOL AT %QX0.4;
    outletValveOpenStatus : BOOL AT %QX0.3;
    inletValveOpenStatus : BOOL AT %QX0.5;
    airValveOpenStatus : BOOL AT %QX0.6;
    level : INT AT %IW2;
    level_max : INT AT %IW3;
    level_min : INT := 10;
  END_VAR





IF (level >= level_max) AND airValveOpenStatus THEN
  openOutletValve := TRUE;
  outletValveOpenStatus := TRUE;
  openInletValve := FALSE;
  inletValveOpenStatus := FALSE;
END_IF;

IF (level < (level_max - level_min)) AND airValveOpenStatus THEN
  openOutletValve := FALSE;
  outletValveOpenStatus := FALSE;
  openInletValve := TRUE;
  inletValveOpenStatus := TRUE;
END_IF;

IF NOT airValveOpenStatus THEN
  openOutletValve := FALSE;
  outletValveOpenStatus := FALSE;
  openInletValve := FALSE;
  inletValveOpenStatus := FALSE;
END_IF;