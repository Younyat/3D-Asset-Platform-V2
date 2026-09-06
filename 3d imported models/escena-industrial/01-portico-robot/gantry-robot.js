/**
 * gantry-robot.js — PÓRTICO ROBOT AMARILLO · 5 EJES + GARRA RADIAL DE 4 DEDOS
 * Objeto independiente. Metros · Y arriba · origen en el centro del plato base.
 *
 * Huella: plato Ø 1,40 m · altura de columna 2,30 m · voladizo útil 1,90 m
 * Alcance del cabezal: 1,35 … 1,90 m desde el eje de la columna
 */
import { ModelBase, makeHelpers } from '../_shared/model-api.js';

export const MODEL = {
  id: 'gantry-robot-5axis',
  version: '1.0',
  label: 'Pórtico robot · 5 ejes',
  rootName: 'GantryRobot5Axis',
  units: 'meters',
  up: 'Y',
  contractRole: 'pick_place_overhead',
  footprint: { diameter: 1.40, height: 2.30, reach: [1.35, 1.90] },
  toolFrame: 'G4_head_roll',
  palette: { yellow: 0xf2c019, grey: 0xe6e7e9, steel: 0x9aa0a6, dark: 0x3a3b3d },

  joints: [
    { id: 'G1', name: 'G1_column_yaw', type: 'revolute', axis: 'Y', label: 'G1 · Giro de columna',
      limits: [-180, 180], speed: 45, home: 0, unit: '°',
      moves: 'Gira la columna completa sobre el plato base. Arrastra el brazo, el cabezal y las garras.' },
    { id: 'G2', name: 'G2_boom_extend', type: 'prismatic', axis: 'X', label: 'G2 · Extensión del brazo',
      limits: [0, 0.55], speed: 0.35, home: 0.28, unit: 'm', origin: { x: 0 },
      moves: 'Desliza el brazo en voladizo hacia fuera. Cambia el radio de trabajo sin girar la columna.' },
    { id: 'G3', name: 'G3_head_lift', type: 'prismatic', axis: 'Y', label: 'G3 · Descenso del cabezal',
      limits: [-0.62, 0], speed: 0.45, home: 0, unit: 'm', origin: { y: 0 },
      moves: 'Baja y sube el cabezal por su guía vertical. Valores negativos descienden.' },
    { id: 'G4', name: 'G4_head_roll', type: 'revolute', axis: 'Y', label: 'G4 · Giro del cabezal',
      limits: [-180, 180], speed: 120, home: 0, unit: '°',
      moves: 'Gira el plato de garras sobre su eje vertical para orientar la caja. No cambia su posición.' },
    { id: 'G5', name: 'G5_grip', type: 'revolute', axis: 'Z', label: 'G5 · Garra (4 dedos)',
      limits: [-8, 24], speed: 90, home: 24, unit: '°',
      driven: ['G5_finger_0', 'G5_finger_1', 'G5_finger_2', 'G5_finger_3'],
      moves: 'Abre y cierra los cuatro dedos a la vez. +24° totalmente abierta · −8° cerrada sobre la caja. Un solo valor gobierna los cuatro nodos.' },
  ],

  clips: [
    { name: 'Ciclo_Descarga', duration: 12.0, loop: true,
      does: 'Toma una caja del suelo a la izquierda y la deposita en la cinta de entrada.' },
    { name: 'Ir_A_Reposo', duration: 2.5, loop: false, does: 'Repliegue a la pose de espera.' },
    { name: 'Demo_Ejes', duration: 17.0, loop: true, does: 'Cada eje barre su rango, la garra al final.' },
  ],

  signals: {
    PICK: (m) => m.playClip('Ciclo_Descarga'),
    HOME: (m) => m.playClip('Ir_A_Reposo', { loop: false }),
    GRIP_CLOSE: (m) => m.setJoint('G5', -8),
    GRIP_OPEN: (m) => m.setJoint('G5', 24),
  },

  interop: {
    provides: ['BOX_PLACED_ON_BELT'],
    consumes: ['BELT_READY'],
    handoffFrame: 'G4_head_roll',
    pairsWith: ['conveyor-segment', 'cargo-box'],
  },
};

export function create(THREE, opts = {}) {
  return new GantryRobot(THREE, opts);
}

class GantryRobot extends ModelBase {
  constructor(THREE, opts) {
    super(THREE, MODEL, opts);
    const T = THREE;
    const { box, cyl, sph } = makeHelpers(T);
    const P = MODEL.palette;

    const mYellow = new T.MeshStandardMaterial({ name: 'gantry_yellow', color: P.yellow, roughness: 0.42, metalness: 0.14 });
    const mYellowD = new T.MeshStandardMaterial({ name: 'gantry_yellow_shade', color: 0xd9a80f, roughness: 0.48, metalness: 0.14 });
    const mGrey = new T.MeshStandardMaterial({ name: 'gantry_grey', color: P.grey, roughness: 0.5, metalness: 0.1 });
    const mSteel = new T.MeshStandardMaterial({ name: 'gantry_steel', color: P.steel, roughness: 0.3, metalness: 0.75 });
    const mDark = new T.MeshStandardMaterial({ name: 'gantry_dark', color: P.dark, roughness: 0.7, metalness: 0.2 });
    this.materials = { mYellow, mYellowD, mGrey, mSteel, mDark };

    /* ---------- BASE fija: plato circular ---------- */
    const base = new T.Group(); base.name = 'BASE_fixed'; this.root.add(base);
    const disc = cyl(0.70, 0.70, 0.045, mGrey, 'base_disc', 56);
    disc.position.y = 0.0225; base.add(disc);
    const discRim = new T.Mesh(new T.TorusGeometry(0.70, 0.012, 10, 56), mSteel);
    discRim.name = 'base_rim'; discRim.position.y = 0.045; discRim.rotation.x = Math.PI / 2; base.add(discRim);
    const hub = cyl(0.24, 0.28, 0.09, mGrey, 'base_hub', 40);
    hub.position.y = 0.09; base.add(hub);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const b = cyl(0.014, 0.014, 0.02, mSteel, `base_bolt_${i}`, 10);
      b.position.set(Math.cos(a) * 0.52, 0.05, Math.sin(a) * 0.52); base.add(b);
    }

    /* ---------- G1 · columna triangular en A ---------- */
    const G1 = new T.Group(); G1.name = 'G1_column_yaw'; G1.position.y = 0.135; base.add(G1);
    this.bind('G1', G1);

    const collar = cyl(0.20, 0.22, 0.07, mYellowD, 'column_collar', 36);
    collar.position.y = 0.035; G1.add(collar);

    // dos montantes inclinados que forman la A + travesaños
    const COL_H = 2.16, SPREAD = 0.31;
    [-1, 1].forEach((s, i) => {
      const leg = box(0.085, COL_H, 0.10, mYellow, `column_leg_${i}`);
      leg.position.set(s * SPREAD / 2, COL_H / 2 + 0.07, 0);
      leg.rotation.z = -s * Math.atan((SPREAD / 2 - 0.045) / COL_H);
      G1.add(leg);
    });
    for (let k = 0; k < 2; k++) {
      const y = 0.62 + k * 0.72;
      const f = 1 - (y - 0.07) / COL_H * 0.72;
      const rung = box(SPREAD * f, 0.055, 0.075, mYellowD, `column_rung_${k}`);
      rung.position.y = y; G1.add(rung);
    }
    const colCap = box(0.30, 0.10, 0.155, mYellow, 'column_cap');
    colCap.position.y = COL_H + 0.10; G1.add(colCap);
    // pasarela / guía del brazo
    const boomRail = box(0.90, 0.045, 0.055, mSteel, 'boom_rail');
    boomRail.position.set(0.42, COL_H + 0.16, 0); G1.add(boomRail);

    /* ---------- G2 · brazo en voladizo (desliza en X) ---------- */
    const G2 = new T.Group(); G2.name = 'G2_boom_extend';
    G2.position.set(0.28, COL_H + 0.10, 0); G1.add(G2);
    this.bind('G2', G2);
    MODEL.joints[1].origin = { x: 0 };

    const BOOM_L = 1.62;
    const boom = box(BOOM_L, 0.115, 0.145, mYellow, 'boom_beam');
    boom.position.x = BOOM_L / 2; G2.add(boom);
    const boomTop = box(BOOM_L * 0.94, 0.03, 0.16, mYellowD, 'boom_cover');
    boomTop.position.set(BOOM_L / 2, 0.072, 0); G2.add(boomTop);
    const boomTip = box(0.14, 0.16, 0.17, mYellowD, 'boom_tip');
    boomTip.position.x = BOOM_L; G2.add(boomTip);
    // nervios de refuerzo
    for (let k = 0; k < 4; k++) {
      const rib = box(0.02, 0.145, 0.16, mYellowD, `boom_rib_${k}`);
      rib.position.set(0.28 + k * 0.36, 0, 0); G2.add(rib);
    }
    // guía vertical del cabezal
    const slide = box(0.06, 0.30, 0.06, mSteel, 'head_slide');
    slide.position.set(BOOM_L, -0.15, 0); G2.add(slide);

    /* ---------- G3 · cabezal (desliza en Y) ---------- */
    const G3 = new T.Group(); G3.name = 'G3_head_lift';
    G3.position.set(BOOM_L, -0.20, 0); G2.add(G3);
    this.bind('G3', G3);
    MODEL.joints[2].origin = { y: -0.20 };

    const carriage = box(0.13, 0.10, 0.13, mSteel, 'head_carriage');
    G3.add(carriage);
    const rod = cyl(0.018, 0.018, 0.18, mSteel, 'head_rod', 16);
    rod.position.y = -0.13; G3.add(rod);

    /* ---------- G4 · plato de garras (gira en Y) ---------- */
    const G4 = new T.Group(); G4.name = 'G4_head_roll'; G4.position.y = -0.24; G3.add(G4);
    this.bind('G4', G4);

    const plate = cyl(0.155, 0.175, 0.036, mGrey, 'grip_plate', 40);
    plate.position.y = -0.018; G4.add(plate);
    const plateRim = new T.Mesh(new T.TorusGeometry(0.168, 0.009, 9, 40), mSteel);
    plateRim.name = 'grip_plate_rim'; plateRim.position.y = -0.036; plateRim.rotation.x = Math.PI / 2; G4.add(plateRim);
    const plateHub = sph(0.048, mSteel, 'grip_hub', 20);
    plateHub.position.y = 0.012; G4.add(plateHub);

    /* ---------- G5 · cuatro dedos radiales ---------- */
    // Cada dedo es un grupo girado θ sobre Y (su X local apunta hacia fuera).
    // Cerrar = rotación NEGATIVA sobre su Z local. Un valor gobierna los 4.
    this.fingers = [];
    for (let i = 0; i < 4; i++) {
      const th = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const f = new T.Group(); f.name = `G5_finger_${i}`;
      f.position.set(Math.cos(th) * 0.132, -0.04, Math.sin(th) * 0.132);
      f.rotation.y = -th;
      G4.add(f);
      this.fingers.push(f);

      const knuckle = sph(0.022, mSteel, `finger_knuckle_${i}`, 14);
      f.add(knuckle);
      const bar = box(0.016, 0.20, 0.016, mSteel, `finger_bar_${i}`);
      bar.position.y = -0.10; f.add(bar);
      const tip = box(0.026, 0.05, 0.022, mDark, `finger_tip_${i}`);
      tip.position.set(-0.006, -0.215, 0); tip.rotation.z = 0.22; f.add(tip);
    }
    this.bind('G5', this.fingers[0]);   // nodo representativo; setJoint replica en los 4

    /* ---------- clips ---------- */
    const p = (t, G1v, G2v, G3v, G4v, G5v) => ({ t, G1: G1v, G2: G2v, G3: G3v, G4: G4v, G5: G5v });
    this.buildClip('Ciclo_Descarga', [
      p(0.0,  0,   0.28, 0,     0,   24),
      p(1.6,  -62, 0.50, 0,     0,   24),
      p(2.8,  -62, 0.50, -0.58, 0,   24),
      p(3.6,  -62, 0.50, -0.58, 0,   -8),
      p(4.8,  -62, 0.50, 0,     0,   -8),
      p(7.0,  38,  0.34, 0,     90,  -8),
      p(8.2,  38,  0.34, -0.42, 90,  -8),
      p(9.0,  38,  0.34, -0.42, 90,  24),
      p(10.0, 38,  0.34, 0,     90,  24),
      p(12.0, 0,   0.28, 0,     0,   24),
    ]);
    this.buildClip('Ir_A_Reposo', [
      p(0.0, 38, 0.34, -0.42, 90, 24),
      p(2.5, 0,  0.28, 0,     0,  24),
    ]);
    this.buildClip('Demo_Ejes', [
      p(0.0,  0,    0.28, 0,     0,    24),
      p(1.8,  -180, 0.28, 0,     0,    24),
      p(4.4,  180,  0.28, 0,     0,    24),
      p(6.0,  0,    0.28, 0,     0,    24),
      p(7.2,  0,    0.55, 0,     0,    24),
      p(8.4,  0,    0,    0,     0,    24),
      p(9.4,  0,    0.28, -0.62, 0,    24),
      p(10.6, 0,    0.28, 0,     0,    24),
      p(11.8, 0,    0.28, 0,     180,  24),
      p(13.4, 0,    0.28, 0,     -180, 24),
      p(14.6, 0,    0.28, 0,     0,    24),
      p(15.6, 0,    0.28, 0,     0,    -8),
      p(17.0, 0,    0.28, 0,     0,    24),
    ]);

    this.goHome();
  }

  /** G5 gobierna los cuatro dedos con un solo valor. */
  setJoint(id, value) {
    const v = super.setJoint(id, value);
    if (id === 'G5' && v !== undefined) {
      const a = v * Math.PI / 180;
      for (const f of this.fingers) f.rotation.z = a;
    }
    return v;
  }

  /** Durante un clip, los otros tres dedos siguen al nodo animado. */
  tick() {
    if (!this.action) return;
    const a = this.fingers[0].rotation.z;
    for (let i = 1; i < 4; i++) this.fingers[i].rotation.z = a;
  }
}
