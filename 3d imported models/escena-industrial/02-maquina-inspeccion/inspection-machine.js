/**
 * inspection-machine.js — MÁQUINA DE INSPECCIÓN CON TÚNEL
 * Objeto independiente. Metros · Y arriba.
 * Origen: centro de la huella a nivel del suelo. La cinta atraviesa en X.
 *
 * Huella 1,30 (X) × 1,55 (Z) · altura 2,52 m
 * Túnel: 0,78 ancho × 0,62 alto, centrado a 0,85 m (altura de banda)
 */
import { ModelBase, makeHelpers } from '../_shared/model-api.js';

const BELT_H = 0.85, TUN_W = 0.78, TUN_H = 0.62;
const TUN_BOT = BELT_H - 0.06;              // 0,79 · borde inferior del hueco
const TUN_TOP = TUN_BOT + TUN_H;            // 1,41 · borde superior del hueco
const BX = 1.30, BZ = 1.55, BH = 2.52;

export const MODEL = {
  id: 'inspection-machine',
  version: '1.0',
  label: 'Máquina de inspección',
  rootName: 'InspectionMachine',
  units: 'meters',
  up: 'Y',
  contractRole: 'process_station',
  footprint: { width: BX, depth: BZ, height: BH },
  tunnel: { width: TUN_W, height: TUN_H, bottomY: TUN_BOT, topY: TUN_TOP, axis: 'X' },
  palette: { shell: 0xe6e7e9, shellShade: 0xd0d2d5, dark: 0x2f3134, glass: 0x15171a,
             red: 0xe0392c, green: 0x4bae4f, steel: 0xa8adb2 },

  joints: [
    { id: 'M1', name: 'M1_beacon', type: 'channel', axis: 'S', label: 'M1 · Baliza',
      limits: [0, 2], home: 1, unit: 'estado',
      apply: (m, v) => m.applyBeacon(v),
      moves: 'Baliza de dos luces. 0 = apagada · 1 = verde (en marcha) · 2 = roja (parada/alarma). Canal no geométrico: cambia emisividad de material, no transformaciones.' },
    { id: 'M2', name: 'M2_strip_lights', type: 'channel', axis: 'S', label: 'M2 · Tira de 3 luces',
      limits: [0, 1], home: 0, unit: 'fase',
      apply: (m, v) => m.applyStrip(v),
      moves: 'Las tres luces rojas del frontal superior encienden en secuencia. El valor 0..1 es la fase del barrido; la máquina reparte la fase entre las tres.' },
    { id: 'M3', name: 'M3_door_hinge', type: 'revolute', axis: 'Y', label: 'M3 · Puerta inferior',
      limits: [0, 95], speed: 60, home: 0, unit: '°',
      moves: 'Puerta de mantenimiento. Bisagra vertical en el borde −X de la cara +Z. 0° cerrada · 95° abierta.' },
    { id: 'M4', name: 'M4_fan', type: 'continuous', axis: 'Y', label: 'M4 · Ventilador',
      limits: [-Infinity, Infinity], home: 0, unit: '°',
      moves: 'Rotor tras la rejilla superior. Gira sobre Y (rejilla horizontal). Acumula: rotation.y -= rpm·dt.' },
    { id: 'M5', name: 'M5_screen', type: 'channel', axis: 'S', label: 'M5 · Pantalla',
      limits: [0, 1], home: 1, unit: 'actividad',
      apply: (m, v) => m.applyScreen(v),
      moves: 'Contenido de la pantalla del panel de control. 0 = apagada · 1 = mostrando lectura activa.' },
    { id: 'M6', name: 'M6_curtain_in', type: 'revolute', axis: 'Z', label: 'M6 · Cortina de entrada',
      limits: [0, 62], speed: 180, home: 0, unit: '°',
      driven: ['M6_curtain_in', 'M6_curtain_out'],
      moves: 'Lamas de la cortina del túnel. Se abren al paso de la caja y vuelven por gravedad. Un valor gobierna entrada y salida.' },
  ],

  clips: [
    { name: 'Ciclo_Inspeccion', duration: 6.0, loop: true,
      does: 'Paso de una caja: cortinas se abren, luces recorren, cortinas cierran.' },
    { name: 'Mantenimiento', duration: 3.0, loop: false, does: 'Abre la puerta inferior y detiene la baliza.' },
  ],

  signals: {
    RUN: (m) => { m.setJoint('M1', 1); m.running = true; },
    ALARM: (m) => { m.setJoint('M1', 2); m.running = false; },
    STOP: (m) => { m.setJoint('M1', 0); m.running = false; },
    BOX_ENTERING: (m) => m.pulseCurtain(),
    OPEN_DOOR: (m) => m.setJoint('M3', 95),
    CLOSE_DOOR: (m) => m.setJoint('M3', 0),
  },

  frames: { TUNNEL_IN: [-BX / 2, BELT_H, 0], TUNNEL_OUT: [BX / 2, BELT_H, 0], PANEL: [0.30, 1.10, BZ / 2] },

  interop: {
    provides: ['INSPECTION_OK', 'INSPECTION_FAIL'],
    consumes: ['RUN', 'STOP', 'ALARM', 'BOX_ENTERING'],
    pairsWith: ['conveyor-segment', 'operator'],
  },
};

export function create(THREE, opts = {}) { return new InspectionMachine(THREE, opts); }

class InspectionMachine extends ModelBase {
  constructor(THREE, opts) {
    super(THREE, MODEL, opts);
    const T = THREE;
    const { box, cyl } = makeHelpers(T);
    const P = MODEL.palette;

    const mShell = new T.MeshStandardMaterial({ name: 'mach_shell', color: P.shell, roughness: 0.45, metalness: 0.14 });
    const mShade = new T.MeshStandardMaterial({ name: 'mach_shell_shade', color: P.shellShade, roughness: 0.5, metalness: 0.14 });
    const mDark = new T.MeshStandardMaterial({ name: 'mach_dark', color: P.dark, roughness: 0.6, metalness: 0.25 });
    const mGlass = new T.MeshStandardMaterial({ name: 'mach_glass', color: P.glass, roughness: 0.16, metalness: 0.5 });
    const mSteel = new T.MeshStandardMaterial({ name: 'mach_steel', color: P.steel, roughness: 0.3, metalness: 0.72 });
    this.mRed = new T.MeshStandardMaterial({ name: 'mach_lamp_red', color: P.red, emissive: P.red, emissiveIntensity: 0.9, roughness: 0.35 });
    this.mGreen = new T.MeshStandardMaterial({ name: 'mach_lamp_green', color: P.green, emissive: P.green, emissiveIntensity: 0.2, roughness: 0.35 });
    this.stripMats = [0, 1, 2].map((i) => new T.MeshStandardMaterial({
      name: `mach_strip_${i}`, color: P.red, emissive: P.red, emissiveIntensity: 0.15, roughness: 0.4,
    }));

    const shell = new T.Group(); shell.name = 'SHELL_fixed'; this.root.add(shell);

    /* ---------- carcasa con túnel: 4 bloques alrededor del hueco ---------- */
    const sideZ = (BZ - TUN_W) / 2;
    [-1, 1].forEach((s, i) => {                       // costados del túnel
      const w = box(BX, TUN_TOP, sideZ, mShell, `shell_side_${i}`);
      w.position.set(0, TUN_TOP / 2, s * (TUN_W / 2 + sideZ / 2));
      shell.add(w);
    });
    const below = box(BX, TUN_BOT, TUN_W, mShell, 'shell_below_tunnel');
    below.position.set(0, TUN_BOT / 2, 0); shell.add(below);
    const above = box(BX, BH - TUN_TOP, BZ, mShell, 'shell_above_tunnel');
    above.position.set(0, (BH + TUN_TOP) / 2, 0); shell.add(above);
    // zócalo
    const plinth = box(BX + 0.06, 0.10, BZ + 0.06, mShade, 'shell_plinth');
    plinth.position.y = 0.05; shell.add(plinth);
    // cornisa superior
    const cornice = box(BX + 0.05, 0.07, BZ + 0.05, mShade, 'shell_cornice');
    cornice.position.y = BH - 0.035; shell.add(cornice);
    // marcos del túnel
    [-1, 1].forEach((sx, i) => {
      const fr = box(0.035, TUN_H + 0.10, TUN_W + 0.10, mShade, `tunnel_frame_${i}`);
      fr.position.set(sx * (BX / 2 + 0.017), (TUN_BOT + TUN_TOP) / 2, 0);
      shell.add(fr);
    });

    /* ---------- rejilla de ventilación superior (cara +Z) ---------- */
    const grillePlate = box(0.86, 0.46, 0.014, mDark, 'grille_plate');
    grillePlate.position.set(-0.02, BH - 0.42, BZ / 2 + 0.008); shell.add(grillePlate);
    for (let i = 0; i < 11; i++) {
      const slat = box(0.83, 0.020, 0.012, mShade, `grille_slat_${i}`);
      slat.position.set(-0.02, BH - 0.62 + i * 0.038, BZ / 2 + 0.017);
      shell.add(slat);
    }

    /* ---------- M4 · ventilador tras la rejilla ---------- */
    const M4 = new T.Group(); M4.name = 'M4_fan';
    M4.position.set(-0.02, BH - 0.42, BZ / 2 - 0.05);
    M4.rotation.x = Math.PI / 2;                       // rotor encarando la rejilla
    shell.add(M4);
    this.bind('M4', M4);
    const hubF = cyl(0.045, 0.045, 0.03, mSteel, 'fan_hub', 18);
    M4.add(hubF);
    for (let i = 0; i < 5; i++) {
      const bl = box(0.028, 0.012, 0.15, mSteel, `fan_blade_${i}`);
      bl.position.set(Math.cos(i / 5 * Math.PI * 2) * 0.10, 0, Math.sin(i / 5 * Math.PI * 2) * 0.10);
      bl.rotation.y = -i / 5 * Math.PI * 2; bl.rotation.x = 0.5;
      M4.add(bl);
    }

    /* ---------- M2 · tres luces rojas rectangulares ---------- */
    const stripBase = box(0.44, 0.09, 0.012, mDark, 'strip_base');
    stripBase.position.set(-0.36, TUN_TOP + 0.32, BZ / 2 + 0.007); shell.add(stripBase);
    this.strips = [0, 1, 2].map((i) => {
      const l = box(0.115, 0.05, 0.014, this.stripMats[i], `M2_light_${i}`);
      l.position.set(-0.50 + i * 0.135, TUN_TOP + 0.32, BZ / 2 + 0.014);
      shell.add(l); return l;
    });
    this.bind('M2', stripBase);

    /* ---------- M1 · baliza de dos luces redondas ---------- */
    const beaconBase = box(0.19, 0.10, 0.012, mDark, 'beacon_base');
    beaconBase.position.set(0.31, TUN_TOP + 0.32, BZ / 2 + 0.007); shell.add(beaconBase);
    this.lampRed = cyl(0.032, 0.032, 0.016, this.mRed, 'M1_lamp_red', 20);
    this.lampRed.rotation.x = Math.PI / 2;
    this.lampRed.position.set(0.265, TUN_TOP + 0.32, BZ / 2 + 0.015); shell.add(this.lampRed);
    this.lampGreen = cyl(0.032, 0.032, 0.016, this.mGreen, 'M1_lamp_green', 20);
    this.lampGreen.rotation.x = Math.PI / 2;
    this.lampGreen.position.set(0.355, TUN_TOP + 0.32, BZ / 2 + 0.015); shell.add(this.lampGreen);
    this.bind('M1', beaconBase);

    /* ---------- visor negro frontal ---------- */
    const visorFrame = box(0.60, 0.52, 0.016, mShade, 'visor_frame');
    visorFrame.position.set(-0.22, 1.10, BZ / 2 + 0.008); shell.add(visorFrame);
    const visor = box(0.54, 0.46, 0.012, mGlass, 'visor_glass');
    visor.position.set(-0.22, 1.10, BZ / 2 + 0.018); shell.add(visor);

    /* ---------- M5 · panel de control con pantalla ---------- */
    const panel = box(0.34, 0.40, 0.05, mShade, 'control_panel');
    panel.position.set(0.30, 1.10, BZ / 2 + 0.026); shell.add(panel);
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 96;
    this.screenCanvas = canvas; this.screenCtx = canvas.getContext('2d');
    this.screenTex = new T.CanvasTexture(canvas);
    this.screenTex.colorSpace = T.SRGBColorSpace;
    const mScreen = new T.MeshStandardMaterial({ name: 'mach_screen', map: this.screenTex, emissiveMap: this.screenTex, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.28 });
    const screen = box(0.24, 0.17, 0.008, mScreen, 'M5_screen');
    screen.position.set(0.30, 1.22, BZ / 2 + 0.055); shell.add(screen);
    this.bind('M5', screen);
    // teclado
    const keypad = box(0.22, 0.11, 0.014, mDark, 'keypad_base');
    keypad.position.set(0.30, 1.00, BZ / 2 + 0.056); shell.add(keypad);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
      const k = box(0.036, 0.021, 0.008, mShade, `key_${r}_${c}`);
      k.position.set(0.30 - 0.078 + c * 0.052, 1.032 - r * 0.032, BZ / 2 + 0.064);
      shell.add(k);
    }

    /* ---------- M3 · puerta inferior abatible ---------- */
    const M3 = new T.Group(); M3.name = 'M3_door_hinge';
    M3.position.set(-0.46, 0.10, BZ / 2 + 0.01); shell.add(M3);
    this.bind('M3', M3);
    const door = box(0.86, 0.56, 0.022, mShade, 'door_panel');
    door.position.set(0.43, 0.30, 0); M3.add(door);
    const handle = cyl(0.008, 0.008, 0.10, mSteel, 'door_handle', 12);
    handle.position.set(0.80, 0.30, 0.02); M3.add(handle);

    /* ---------- M6 · cortinas del túnel ---------- */
    this.curtains = [];
    [['in', -1], ['out', 1]].forEach(([tag, sx]) => {
      const g = new T.Group(); g.name = `M6_curtain_${tag}`;
      g.position.set(sx * (BX / 2 + 0.03), TUN_TOP - 0.02, 0);
      shell.add(g);
      this.curtains.push({ node: g, side: sx });
      for (let i = 0; i < 5; i++) {
        const strip = box(0.008, TUN_H - 0.06, TUN_W / 5 - 0.012, mDark, `curtain_${tag}_${i}`);
        strip.position.set(0, -(TUN_H - 0.06) / 2, -TUN_W / 2 + TUN_W / 10 + i * TUN_W / 5);
        g.add(strip);
      }
    });
    this.bind('M6', this.curtains[0].node);

    /* ---------- clips ---------- */
    this.buildClip('Ciclo_Inspeccion', [
      { t: 0.0, M3: 0, M6: 0 }, { t: 0.6, M3: 0, M6: 58 },
      { t: 2.4, M3: 0, M6: 20 }, { t: 3.0, M3: 0, M6: 0 },
      { t: 6.0, M3: 0, M6: 0 },
    ]);
    this.buildClip('Mantenimiento', [
      { t: 0.0, M3: 0, M6: 0 }, { t: 3.0, M3: 95, M6: 0 },
    ]);

    this.running = true;
    this.fanRpm = 420;
    this._t = 0;
    this._curtainPulse = 0;
    this.goHome();
    this.applyScreen(1);
  }

  /* ---------- canales ---------- */

  applyBeacon(state) {
    const s = Math.round(state);
    this.mGreen.emissiveIntensity = s === 1 ? 1.1 : 0.12;
    this.mRed.emissiveIntensity = s === 2 ? 1.2 : 0.15;
  }

  applyStrip(phase) {
    for (let i = 0; i < 3; i++) {
      const d = Math.abs(((phase * 3) % 3) - i);
      this.stripMats[i].emissiveIntensity = 0.15 + Math.max(0, 1 - d) * 1.15;
    }
  }

  applyScreen(active) {
    const g = this.screenCtx, c = this.screenCanvas;
    g.fillStyle = active > 0.05 ? '#0d1a14' : '#0a0a0b';
    g.fillRect(0, 0, c.width, c.height);
    if (active > 0.05) {
      g.fillStyle = '#5fe08a';
      g.font = '600 11px monospace';
      g.fillText('SCAN', 8, 16);
      g.fillText(`${(this.boxCount ?? 0).toString().padStart(4, '0')}`, 84, 16);
      // traza de lectura
      g.strokeStyle = '#5fe08a'; g.lineWidth = 1.5; g.beginPath();
      for (let x = 0; x < c.width; x += 4) {
        const y = 60 + Math.sin((x + (this._t ?? 0) * 60) * 0.09) * 14 * active;
        x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
      g.fillStyle = '#2b6b45';
      for (let i = 0; i < 4; i++) g.fillRect(8 + i * 30, 26, 22, 5);
    }
    this.screenTex.needsUpdate = true;
  }

  /** Impulso de cortina: se abre y vuelve sola. */
  pulseCurtain() { this._curtainPulse = 1; }

  tick(dt) {
    this._t += dt;
    if (this.running) {
      this.nodes.M4.rotation.y -= (this.fanRpm / 60) * Math.PI * 2 * dt;
      this.setJoint('M2', (this._t * 0.5) % 1);
      if ((this._frame = ((this._frame ?? 0) + 1) % 4) === 0) this.applyScreen(this.getJoint('M5'));
    }
    // retorno elástico de las cortinas
    if (this._curtainPulse > 0.001 && !this.action) {
      this._curtainPulse = Math.max(0, this._curtainPulse - dt * 1.6);
      const a = Math.sin(this._curtainPulse * Math.PI) * 58;
      for (const c of this.curtains) c.node.rotation.z = -c.side * a * Math.PI / 180;
    }
    if (this.action) {           // durante el clip, la salida copia la entrada
      this.curtains[1].node.rotation.z = -this.curtains[0].node.rotation.z;
    }
  }
}
