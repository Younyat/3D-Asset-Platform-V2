/**
 * operator.js — OPERARIO ARTICULADO
 * Objeto independiente. Metros · Y arriba. Origen entre los pies (y = 0).
 * Altura 1,75 m. Figura simplificada de volúmenes, con 9 ejes articulados
 * suficientes para pulsar el panel, girar la cabeza y desplazar el peso.
 *
 * No es un personaje con esqueleto ni piel: es una cadena de sólidos, como
 * las máquinas. Se mueve con el mismo contrato que el resto de los modelos.
 */
import { ModelBase, makeHelpers } from '../_shared/model-api.js';

export const MODEL = {
  id: 'operator',
  version: '1.0',
  label: 'Operario',
  rootName: 'Operator',
  units: 'meters',
  up: 'Y',
  contractRole: 'human',
  footprint: { width: 0.48, depth: 0.30, height: 1.75 },
  facing: '+X',
  palette: { coat: 0xa9dcd2, coatShade: 0x8fc9be, skin: 0xd9a884, hair: 0x40332a, shoe: 0xf2f1ef, trouser: 0x9ccfc5 },

  joints: [
    { id: 'O1', name: 'O1_hips_yaw', type: 'revolute', axis: 'Y', label: 'O1 · Caderas',
      limits: [-60, 60], speed: 90, home: 0, unit: '°',
      moves: 'Gira el cuerpo entero desde las caderas. Arrastra torso, brazos y cabeza. Es el eje que reorienta al operario ante la máquina.' },
    { id: 'O2', name: 'O2_spine_pitch', type: 'revolute', axis: 'Z', label: 'O2 · Inclinación de torso',
      limits: [-12, 28], speed: 60, home: 4, unit: '°',
      moves: 'Inclina el torso hacia delante. Positivo se agacha hacia el panel.' },
    { id: 'O3', name: 'O3_spine_twist', type: 'revolute', axis: 'Y', label: 'O3 · Torsión de torso',
      limits: [-40, 40], speed: 80, home: 0, unit: '°',
      moves: 'Torsión del torso sobre las caderas, independiente de O1.' },
    { id: 'O4', name: 'O4_head_yaw', type: 'revolute', axis: 'Y', label: 'O4 · Cabeza (giro)',
      limits: [-75, 75], speed: 140, home: 0, unit: '°',
      moves: 'Gira la cabeza para mirar a un lado. No mueve nada más.' },
    { id: 'O5', name: 'O5_head_pitch', type: 'revolute', axis: 'Z', label: 'O5 · Cabeza (cabeceo)',
      limits: [-25, 35], speed: 120, home: 8, unit: '°',
      moves: 'Baja o sube la mirada. Positivo mira hacia abajo, al panel.' },
    { id: 'O6', name: 'O6_shoulder_R', type: 'revolute', axis: 'Z', label: 'O6 · Hombro derecho',
      limits: [-100, 100], speed: 180, home: 30, unit: '°',
      moves: 'Eleva y adelanta el brazo derecho. POSITIVO lo lleva hacia delante (+X, el frente del modelo); negativo hacia atrás.' },
    { id: 'O7', name: 'O7_elbow_R', type: 'revolute', axis: 'Z', label: 'O7 · Codo derecho',
      limits: [0, 130], speed: 220, home: 78, unit: '°',
      moves: 'Flexión del codo derecho. Es el eje que produce el gesto de pulsar tecla: oscila ±8° alrededor de su valor de reposo.' },
    { id: 'O8', name: 'O8_shoulder_L', type: 'revolute', axis: 'Z', label: 'O8 · Hombro izquierdo',
      limits: [-100, 100], speed: 180, home: 8, unit: '°',
      moves: 'Brazo izquierdo, en reposo junto al cuerpo por defecto.' },
    { id: 'O9', name: 'O9_elbow_L', type: 'revolute', axis: 'Z', label: 'O9 · Codo izquierdo',
      limits: [0, 130], speed: 220, home: 18, unit: '°',
      moves: 'Flexión del codo izquierdo.' },
  ],

  clips: [
    { name: 'Operar_Panel', duration: 5.0, loop: true,
      does: 'Pulsa tres teclas del panel con la mano derecha y consulta la pantalla.' },
    { name: 'Mirar_Cinta', duration: 4.0, loop: true,
      does: 'Gira el torso y la cabeza hacia la cinta y vuelve al panel.' },
    { name: 'Reposo', duration: 6.0, loop: true, does: 'Respiración y micromovimiento de peso.' },
    { name: 'Demo_Ejes', duration: 14.0, loop: true, does: 'Cada eje barre su rango en orden O1→O9.' },
  ],

  signals: {
    PRESS: (m) => m.playClip('Operar_Panel'),
    LOOK_AT_BELT: (m) => m.playClip('Mirar_Cinta'),
    IDLE: (m) => m.playClip('Reposo'),
  },

  frames: { RIGHT_HAND: 'O7_elbow_R', HEAD: 'O4_head_yaw' },

  interop: {
    provides: ['PANEL_PRESSED'],
    consumes: ['PRESS', 'LOOK_AT_BELT', 'IDLE'],
    pairsWith: ['inspection-machine'],
  },
};

export function create(THREE, opts = {}) { return new Operator(THREE, opts); }

class Operator extends ModelBase {
  constructor(THREE, opts) {
    super(THREE, MODEL, opts);
    const T = THREE;
    const { box, cyl, sph } = makeHelpers(T);
    const P = MODEL.palette;

    const mCoat = new T.MeshStandardMaterial({ name: 'op_coat', color: P.coat, roughness: 0.72, metalness: 0.02 });
    const mCoatD = new T.MeshStandardMaterial({ name: 'op_coat_shade', color: P.coatShade, roughness: 0.74, metalness: 0.02 });
    const mTrouser = new T.MeshStandardMaterial({ name: 'op_trouser', color: P.trouser, roughness: 0.76, metalness: 0.02 });
    const mSkin = new T.MeshStandardMaterial({ name: 'op_skin', color: P.skin, roughness: 0.68, metalness: 0.01 });
    const mHair = new T.MeshStandardMaterial({ name: 'op_hair', color: P.hair, roughness: 0.62, metalness: 0.04 });
    const mShoe = new T.MeshStandardMaterial({ name: 'op_shoe', color: P.shoe, roughness: 0.55, metalness: 0.05 });

    /* ---------- piernas y pies: fijos (no articulados) ---------- */
    const legs = new T.Group(); legs.name = 'LEGS_fixed'; this.root.add(legs);
    [-1, 1].forEach((s, i) => {
      const thigh = cyl(0.078, 0.066, 0.50, mTrouser, `thigh_${i}`, 18);
      thigh.position.set(0, 0.67, s * 0.098); legs.add(thigh);
      const shin = cyl(0.062, 0.052, 0.44, mTrouser, `shin_${i}`, 18);
      shin.position.set(0, 0.23, s * 0.098); legs.add(shin);
      const shoe = box(0.21, 0.058, 0.105, mShoe, `shoe_${i}`);
      shoe.position.set(0.032, 0.029, s * 0.098); legs.add(shoe);
    });

    /* ---------- O1 · caderas ---------- */
    const O1 = new T.Group(); O1.name = 'O1_hips_yaw'; O1.position.y = 0.92; this.root.add(O1);
    this.bind('O1', O1);
    const hips = box(0.31, 0.15, 0.23, mCoatD, 'hips');
    hips.position.y = -0.02; O1.add(hips);

    /* ---------- O2 · inclinación · O3 · torsión ---------- */
    const O2 = new T.Group(); O2.name = 'O2_spine_pitch'; O1.add(O2);
    this.bind('O2', O2);
    const O3 = new T.Group(); O3.name = 'O3_spine_twist'; O2.add(O3);
    this.bind('O3', O3);

    // bata: torso + faldón que cae por debajo de las caderas
    const torso = box(0.35, 0.52, 0.24, mCoat, 'coat_torso');
    torso.position.y = 0.26; O3.add(torso);
    const skirt = box(0.37, 0.28, 0.26, mCoat, 'coat_skirt');
    skirt.position.y = -0.12; O3.add(skirt);
    const placket = box(0.03, 0.76, 0.25, mCoatD, 'coat_placket');
    placket.position.set(0.165, 0.12, 0); O3.add(placket);
    const collar = cyl(0.088, 0.093, 0.05, mCoatD, 'coat_collar', 20);
    collar.position.y = 0.54; O3.add(collar);

    /* ---------- cuello, O4 · giro de cabeza, O5 · cabeceo ---------- */
    const neck = cyl(0.046, 0.046, 0.08, mSkin, 'neck', 16);
    neck.position.y = 0.58; O3.add(neck);
    const O4 = new T.Group(); O4.name = 'O4_head_yaw'; O4.position.y = 0.62; O3.add(O4);
    this.bind('O4', O4);
    const O5 = new T.Group(); O5.name = 'O5_head_pitch'; O4.add(O5);
    this.bind('O5', O5);
    const head = sph(0.098, mSkin, 'head', 26);
    head.scale.set(0.94, 1.06, 1.0); head.position.y = 0.095; O5.add(head);
    const hair = sph(0.104, mHair, 'hair', 26);
    hair.scale.set(0.96, 1.02, 1.0); hair.position.set(-0.012, 0.104, 0); O5.add(hair);
    const napeHair = box(0.10, 0.07, 0.16, mHair, 'hair_nape');
    napeHair.position.set(-0.052, 0.048, 0); O5.add(napeHair);
    const ear = (s) => { const e = sph(0.022, mSkin, `ear_${s}`, 12); e.scale.set(0.5, 1, 0.8); e.position.set(0.005, 0.09, s * 0.096); O5.add(e); };
    ear(-1); ear(1);

    /* ---------- brazos: O6/O7 derecho · O8/O9 izquierdo ---------- */
    const arm = (tag, side, shId, elId) => {
      const SH = new T.Group(); SH.name = `O${tag}_shoulder_${side > 0 ? 'R' : 'L'}`;
      SH.position.set(0.01, 0.48, side * 0.19); O3.add(SH);
      this.bind(shId, SH);
      const upper = cyl(0.052, 0.046, 0.29, mCoat, `upper_arm_${side > 0 ? 'R' : 'L'}`, 18);
      upper.position.y = -0.145; SH.add(upper);
      const shoulderCap = sph(0.058, mCoat, `shoulder_cap_${side > 0 ? 'R' : 'L'}`, 16);
      SH.add(shoulderCap);

      const EL = new T.Group(); EL.name = `O${tag + 1}_elbow_${side > 0 ? 'R' : 'L'}`;
      EL.position.y = -0.29; SH.add(EL);
      this.bind(elId, EL);
      const lower = cyl(0.044, 0.038, 0.26, mCoat, `lower_arm_${side > 0 ? 'R' : 'L'}`, 18);
      lower.position.y = -0.13; EL.add(lower);
      const cuff = cyl(0.04, 0.04, 0.03, mCoatD, `cuff_${side > 0 ? 'R' : 'L'}`, 16);
      cuff.position.y = -0.255; EL.add(cuff);
      const hand = sph(0.045, mSkin, `hand_${side > 0 ? 'R' : 'L'}`, 16);
      hand.scale.set(0.8, 1.05, 0.6); hand.position.y = -0.30; EL.add(hand);
      return { SH, EL };
    };
    arm(6, 1, 'O6', 'O7');
    arm(8, -1, 'O8', 'O9');

    /* ---------- clips ---------- */
    // El frente del modelo es +X: hombro POSITIVO lleva el brazo hacia delante.
    const pose = (t, o) => ({ t, O1: 0, O2: 4, O3: 0, O4: 0, O5: 8, O6: 30, O7: 78, O8: 8, O9: 18, ...o });

    this.buildClip('Operar_Panel', [
      pose(0.0, {}),
      pose(0.8, { O6: 34, O7: 70, O5: 12 }),           // extiende hacia la tecla
      pose(1.2, { O6: 32, O7: 86, O5: 12 }),           // pulsa
      pose(1.7, { O6: 34, O7: 70, O5: 12 }),
      pose(2.1, { O6: 32, O7: 86, O5: 12 }),           // pulsa
      pose(2.6, { O6: 37, O7: 66, O5: 6 }),
      pose(3.0, { O6: 33, O7: 84, O5: 6 }),            // pulsa
      pose(3.6, { O6: 30, O7: 78, O5: 2, O4: -8 }),    // consulta la pantalla
      pose(5.0, {}),
    ]);

    this.buildClip('Mirar_Cinta', [
      pose(0.0, {}),
      pose(1.2, { O1: 24, O3: 22, O4: 34, O5: 0, O6: 14, O7: 40 }),
      pose(2.4, { O1: 24, O3: 22, O4: 46, O5: -4, O6: 14, O7: 40 }),
      pose(4.0, {}),
    ]);

    this.buildClip('Reposo', [
      pose(0.0, {}),
      pose(1.6, { O2: 6, O5: 10, O8: 12 }),
      pose(3.2, { O2: 3, O5: 7, O1: -3 }),
      pose(4.6, { O2: 6, O5: 9, O8: 4 }),
      pose(6.0, {}),
    ]);

    this.buildClip('Demo_Ejes', [
      pose(0.0, {}),
      pose(1.0, { O1: -60 }), pose(2.0, { O1: 60 }), pose(2.6, {}),
      pose(3.4, { O2: 28 }), pose(4.0, { O2: -12 }), pose(4.4, {}),
      pose(5.2, { O3: 40 }), pose(5.8, { O3: -40 }), pose(6.2, {}),
      pose(7.0, { O4: 75 }), pose(7.6, { O4: -75 }), pose(8.0, {}),
      pose(8.6, { O5: 35 }), pose(9.0, { O5: -25 }), pose(9.4, {}),
      pose(10.2, { O6: 100, O7: 130 }), pose(10.8, { O6: -100, O7: 0 }), pose(11.4, {}),
      pose(12.2, { O8: 100, O9: 130 }), pose(12.8, { O8: -100, O9: 0 }),
      pose(14.0, {}),
    ]);

    this.goHome();
  }
}
