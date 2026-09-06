/**
 * industrial-arm.js — BRAZO INDUSTRIAL DE 6 EJES + PINZA (blanco).
 * Objeto 3D independiente. Unidades: metros. Y arriba. Origen en la base, y=0.
 * Alcance ~1,05 m · carga nominal 10 kg · pinza paralela de 2 dedos.
 */
import * as THREE from 'three';
import { buildPanel } from './rig-ui.js';

const stage = document.querySelector('three-d-stage');
const { THREE: T } = await stage.ready;
const deg = T.MathUtils.degToRad;

/* materiales */
const mWhite = new T.MeshStandardMaterial({ name: 'cast_white', color: 0xf2f1ef, roughness: 0.42, metalness: 0.08 });
const mShade = new T.MeshStandardMaterial({ name: 'cast_white_shade', color: 0xdedcd8, roughness: 0.5, metalness: 0.08 });
const mAlu   = new T.MeshStandardMaterial({ name: 'machined_alu', color: 0xb4b8bc, roughness: 0.28, metalness: 0.72 });
const mDark  = new T.MeshStandardMaterial({ name: 'bolt_dark', color: 0x2a2c2f, roughness: 0.55, metalness: 0.3 });
const mPad   = new T.MeshStandardMaterial({ name: 'grip_pad', color: 0x1b1c1e, roughness: 0.88, metalness: 0.04 });

const root = new T.Group();
root.name = 'IndustrialArm6DOF';

const box = (w, h, d, mat, name, r = 0.008) => {
  const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat); m.name = name; return m;
};
const cyl = (r1, r2, h, mat, name, segs = 40) => {
  const m = new T.Mesh(new T.CylinderGeometry(r1, r2, h, segs), mat); m.name = name; return m;
};
/** fila de tornillos avellanados sobre una cara (estetica de fundicion) */
function boltRow(parent, count, spacing, y, z, name, radius = 0.0055) {
  for (let i = 0; i < count; i++) {
    const b = cyl(radius, radius, 0.006, mDark, `${name}_${i}`, 10);
    b.rotation.x = Math.PI / 2;
    b.position.set(0, y + (i - (count - 1) / 2) * spacing, z);
    parent.add(b);
  }
}

/* ---------- BASE fija: placa atornillada al suelo + pedestal ---------- */
const base = new T.Group(); base.name = 'BASE_fixed'; root.add(base);
const plate = box(0.40, 0.022, 0.40, mWhite, 'base_plate');
plate.position.y = 0.011; base.add(plate);
for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
  const pad = cyl(0.026, 0.026, 0.026, mWhite, `base_pad_${sx}_${sz}`, 24);
  pad.position.set(sx * 0.163, 0.013, sz * 0.163); base.add(pad);
  const bolt = cyl(0.011, 0.011, 0.014, mAlu, `base_bolt_${sx}_${sz}`, 16);
  bolt.position.set(sx * 0.163, 0.03, sz * 0.163); base.add(bolt);
}
const pedestal = cyl(0.115, 0.145, 0.20, mWhite, 'base_pedestal');
pedestal.position.y = 0.122; base.add(pedestal);
const pedRing = new T.Mesh(new T.TorusGeometry(0.118, 0.008, 14, 44), mAlu);
pedRing.name = 'pedestal_ring'; pedRing.position.y = 0.222; pedRing.rotation.x = Math.PI / 2; base.add(pedRing);

/* ---------- J1 · giro de base (Y) ---------- */
const J1 = new T.Group(); J1.name = 'J1_base_yaw'; J1.position.y = 0.228; base.add(J1);
const turret = box(0.20, 0.16, 0.22, mWhite, 'turret_body');
turret.position.y = 0.08; J1.add(turret);
const turretShoulder = cyl(0.075, 0.075, 0.19, mShade, 'shoulder_yoke');
turretShoulder.rotation.x = Math.PI / 2; turretShoulder.position.set(0.01, 0.155, 0); J1.add(turretShoulder);
boltRow(J1, 4, 0.032, 0.155, 0.096, 'shoulder_bolt');

/* ---------- J2 · hombro (Z) ---------- */
const J2 = new T.Group(); J2.name = 'J2_shoulder_pitch'; J2.position.set(0.01, 0.155, 0); J1.add(J2);
const L_UPPER = 0.42;
const upper = box(0.115, L_UPPER, 0.145, mWhite, 'upper_arm');
upper.position.y = L_UPPER / 2; J2.add(upper);
[-1, 1].forEach((s, i) => {
  const web = box(0.014, L_UPPER * 0.86, 0.175, mShade, `upper_arm_web_${i}`);
  web.position.set(s * 0.058, L_UPPER / 2, 0); J2.add(web);
  boltRow(J2, 5, 0.062, L_UPPER / 2, 0.088, `upper_bolt_${i}`);
});
const j2Cap = cyl(0.072, 0.072, 0.155, mShade, 'j2_cap');
j2Cap.rotation.x = Math.PI / 2; J2.add(j2Cap);

/* ---------- J3 · codo (Z) ---------- */
const J3 = new T.Group(); J3.name = 'J3_elbow_pitch'; J3.position.y = L_UPPER; J2.add(J3);
const j3Cap = cyl(0.062, 0.062, 0.13, mShade, 'j3_cap');
j3Cap.rotation.x = Math.PI / 2; J3.add(j3Cap);
const L_FORE = 0.20;
const foreLower = box(0.095, L_FORE, 0.115, mWhite, 'forearm_lower');
foreLower.position.y = L_FORE / 2; J3.add(foreLower);

/* ---------- J4 · giro de antebrazo (Y) ---------- */
const J4 = new T.Group(); J4.name = 'J4_forearm_roll'; J4.position.y = L_FORE; J3.add(J4);
const j4Ring = new T.Mesh(new T.TorusGeometry(0.05, 0.007, 12, 34), mAlu);
j4Ring.name = 'j4_ring'; j4Ring.rotation.x = Math.PI / 2; J4.add(j4Ring);
const L_FORE2 = 0.185;
const foreUpper = cyl(0.046, 0.05, L_FORE2, mWhite, 'forearm_upper');
foreUpper.position.y = L_FORE2 / 2; J4.add(foreUpper);
const foreFin = box(0.012, L_FORE2 * 0.7, 0.085, mShade, 'forearm_fin');
foreFin.position.set(0, L_FORE2 / 2, 0.03); J4.add(foreFin);

/* ---------- J5 · cabeceo de muneca (Z) ---------- */
const J5 = new T.Group(); J5.name = 'J5_wrist_pitch'; J5.position.y = L_FORE2; J4.add(J5);
const j5Yoke = cyl(0.042, 0.042, 0.10, mShade, 'wrist_yoke');
j5Yoke.rotation.x = Math.PI / 2; J5.add(j5Yoke);
const wristBody = box(0.07, 0.075, 0.078, mWhite, 'wrist_body');
wristBody.position.y = 0.038; J5.add(wristBody);

/* ---------- J6 · giro de herramienta (Y) ---------- */
const J6 = new T.Group(); J6.name = 'J6_tool_roll'; J6.position.y = 0.075; J5.add(J6);
const flange = cyl(0.032, 0.032, 0.012, mAlu, 'tool_flange');
flange.position.y = 0.006; J6.add(flange);

/* ---------- G1 · pinza paralela de 2 dedos (traslacion X) ---------- */
const gripper = new T.Group(); gripper.name = 'GRIPPER_body'; gripper.position.y = 0.012; J6.add(gripper);
const gripBody = box(0.115, 0.055, 0.072, mWhite, 'gripper_housing');
gripBody.position.y = 0.028; gripper.add(gripBody);
const gripRail = box(0.13, 0.012, 0.03, mAlu, 'gripper_rail');
gripRail.position.y = 0.055; gripper.add(gripRail);

const OPEN = 0.048, CLOSED = 0.014, L_FINGER = 0.10;
const fingers = {};
[['L', -1], ['R', 1]].forEach(([tag, side]) => {
  const g = new T.Group(); g.name = `G1_finger_${tag}`;
  g.position.set(side * OPEN, 0.058, 0); gripper.add(g);
  fingers[tag] = { node: g, side };
  const carriage = box(0.032, 0.022, 0.05, mAlu, `finger_carriage_${tag}`);
  carriage.position.y = 0.011; g.add(carriage);
  const jaw = box(0.016, L_FINGER, 0.046, mWhite, `finger_jaw_${tag}`);
  jaw.position.y = 0.022 + L_FINGER / 2; g.add(jaw);
  const tip = box(0.014, 0.03, 0.05, mShade, `finger_tip_${tag}`);
  tip.position.set(-side * 0.004, 0.022 + L_FINGER - 0.01, 0); g.add(tip);
  const pad = box(0.005, 0.05, 0.042, mPad, `finger_pad_${tag}`);
  pad.position.set(-side * 0.009, 0.022 + L_FINGER * 0.62, 0); g.add(pad);
});

/* ================= RIG ================= */
const RIG = [
  { id: 'J1', node: J1, name: 'J1_base_yaw',        axis: 'y', label: 'J1 · Base',        min: -170, max: 170, speed: 200, home: 0 },
  { id: 'J2', node: J2, name: 'J2_shoulder_pitch',  axis: 'z', label: 'J2 · Hombro',      min: -100, max: 80,  speed: 150, home: -20 },
  { id: 'J3', node: J3, name: 'J3_elbow_pitch',     axis: 'z', label: 'J3 · Codo',        min: -60,  max: 145, speed: 170, home: 70 },
  { id: 'J4', node: J4, name: 'J4_forearm_roll',    axis: 'y', label: 'J4 · Antebrazo',   min: -190, max: 190, speed: 300, home: 0 },
  { id: 'J5', node: J5, name: 'J5_wrist_pitch',     axis: 'z', label: 'J5 · Muñeca',      min: -120, max: 120, speed: 300, home: 40 },
  { id: 'J6', node: J6, name: 'J6_tool_roll',       axis: 'y', label: 'J6 · Herramienta', min: -360, max: 360, speed: 420, home: 0 },
];
const byId = Object.fromEntries(RIG.map((j) => [j.id, j]));
const setJoint = (id, d) => {
  const j = byId[id]; const v = T.MathUtils.clamp(d, j.min, j.max);
  j.node.rotation[j.axis] = deg(v); return v;
};
const setGrip = (t) => { // 1 abierta · 0 cerrada
  const x = CLOSED + (OPEN - CLOSED) * T.MathUtils.clamp(t, 0, 1);
  fingers.L.node.position.x = -x; fingers.R.node.position.x = x;
  return x;
};

/* ================= CLIPS ================= */
const P = (t, J1, J2, J3, J4, J5, J6, grip) => ({ t, J1, J2, J3, J4, J5, J6, grip });

// Toma de la cinta (frente, J1=0) y deposito en palet (lateral, J1=95).
const CINTA = [
  P(0.0,  0,  -20, 70,  0,   40,  0,    1),
  P(1.3,  0,  10,  75,  0,   35,  0,    1),
  P(2.3,  0,  32,  72,  0,   16,  0,    1),
  P(3.1,  0,  32,  72,  0,   16,  0,    0),
  P(4.0,  0,  10,  75,  0,   35,  0,    0),
  P(5.6,  95, 10,  75,  90,  35,  0,    0),
  P(6.7,  95, 32,  72,  90,  16,  0,    0),
  P(7.5,  95, 32,  72,  90,  16,  0,    1),
  P(8.4,  95, 10,  75,  90,  35,  0,    1),
  P(10.0, 0,  -20, 70,  0,   40,  0,    1),
];

// Paletizado en 4 posiciones con giro de herramienta alterno.
const PALET = [
  P(0.0,  0,   -20, 70, 0,   40, 0,   1),
  P(1.6,  0,   28,  74, 0,   18, 0,   1),
  P(2.3,  0,   28,  74, 0,   18, 0,   0),
  P(3.2,  0,   0,   72, 0,   40, 0,   0),
  P(4.6,  70,  0,   72, 70,  40, 0,   0),
  P(5.6,  70,  30,  70, 70,  20, 0,   0),
  P(6.3,  70,  30,  70, 70,  20, 0,   1),
  P(7.2,  70,  0,   72, 70,  40, 0,   1),
  P(8.6,  120, 0,   72, 120, 40, 90,  1),
  P(9.6,  120, 30,  70, 120, 20, 90,  1),
  P(10.3, 120, 30,  70, 120, 20, 90,  0),
  P(11.2, 120, 0,   72, 120, 40, 90,  0),
  P(12.6, 0,   -20, 70, 0,   40, 0,   0),
  P(13.4, 0,   -20, 70, 0,   40, 0,   1),
];

const DEMO = [
  P(0.0,  0,    -20, 70,  0,    40,   0,    1),
  P(1.6,  -170, -20, 70,  0,    40,   0,    1),
  P(4.0,  170,  -20, 70,  0,    40,   0,    1),
  P(5.4,  0,    -20, 70,  0,    40,   0,    1),
  P(6.4,  0,    80,  70,  0,    40,   0,    1),
  P(7.6,  0,    -100, 70, 0,    40,   0,    1),
  P(8.6,  0,    -20, 145, 0,    40,   0,    1),
  P(9.6,  0,    -20, -60, 0,    40,   0,    1),
  P(10.6, 0,    -20, 70,  190,  40,   0,    1),
  P(11.8, 0,    -20, 70,  -190, 40,   0,    1),
  P(12.8, 0,    -20, 70,  0,    120,  0,    1),
  P(13.8, 0,    -20, 70,  0,    -120, 0,    1),
  P(14.8, 0,    -20, 70,  0,    40,   360,  1),
  P(16.0, 0,    -20, 70,  0,    40,   0,    1),
  P(16.8, 0,    -20, 70,  0,    40,   0,    0),
  P(17.6, 0,    -20, 70,  0,    40,   0,    1),
];

function buildClip(name, poses) {
  const times = poses.map((p) => p.t);
  const q = new T.Quaternion(), e = new T.Euler();
  const tracks = RIG.map((j) => {
    const values = [];
    for (const p of poses) {
      const a = deg(T.MathUtils.clamp(p[j.id], j.min, j.max));
      e.set(j.axis === 'x' ? a : 0, j.axis === 'y' ? a : 0, j.axis === 'z' ? a : 0);
      q.setFromEuler(e);
      values.push(q.x, q.y, q.z, q.w);
    }
    return new T.QuaternionKeyframeTrack(`${j.name}.quaternion`, times, values);
  });
  for (const tag of ['L', 'R']) {
    const { node, side } = fingers[tag];
    const values = [];
    for (const p of poses) {
      const x = CLOSED + (OPEN - CLOSED) * p.grip;
      values.push(side * x, node.position.y, 0);
    }
    tracks.push(new T.VectorKeyframeTrack(`G1_finger_${tag}.position`, times, values));
  }
  return new T.AnimationClip(name, times[times.length - 1], tracks);
}

const clips = [
  buildClip('Toma_De_Cinta', CINTA),
  buildClip('Paletizado_4_Posiciones', PALET),
  buildClip('Demo_Ejes', DEMO),
];
root.animations = clips;

root.userData = {
  schema: 'robot-arm-rig/1.1',
  asset: 'industrial-arm-6dof',
  units: 'meters', up: 'Y', toolFrame: 'J6_tool_roll',
  payloadKg: 10, reachMeters: 1.05,
  gripper: { node: 'GRIPPER_body', type: 'parallel_2_finger', axis: 'X', openMeters: OPEN, closedMeters: CLOSED, jawOpenMeters: OPEN * 2, jawClosedMeters: CLOSED * 2 },
  joints: RIG.map((j) => ({
    name: j.name, order: j.id, type: 'revolute', axis: j.axis.toUpperCase(),
    limitsDeg: [j.min, j.max], maxSpeedDegPerSec: j.speed, homeDeg: j.home,
  })).concat([
    { name: 'G1_finger_L', order: 'G1', type: 'prismatic', axis: 'X', limitsMeters: [-OPEN, -CLOSED], maxSpeedMetersPerSec: 0.15 },
    { name: 'G1_finger_R', order: 'G1', type: 'prismatic', axis: 'X', limitsMeters: [CLOSED, OPEN], maxSpeedMetersPerSec: 0.15 },
  ]),
  clips: clips.map((c) => ({ name: c.name, durationSec: +c.duration.toFixed(2), loop: true })),
  interop: {
    role: 'pick_from_conveyor',
    pickFrame: { yawDeg: 0, expectsPartAt: 'conveyor PICK_STATION', graspAtSec: 3.1, releaseAtSec: 7.5, clip: 'Toma_De_Cinta' },
    pairsWith: ['cobot-6dof', 'conveyor-belt-2400'],
  },
};

stage.setObject(root);

/* ================= reproduccion + panel ================= */
const mixer = new T.AnimationMixer(root);
const clock = new T.Clock();
let action = null;
function play(name) {
  const clip = clips.find((c) => c.name === name);
  if (action) action.stop();
  action = mixer.clipAction(clip); action.reset();
  action.setLoop(T.LoopRepeat, Infinity); action.play();
}
function stopClip() { if (action) { action.stop(); action = null; } }

const panel = buildPanel(document.getElementById('rig-ui'), {
  title: 'Brazo industrial · 6 ejes + pinza',
  clips: [
    { name: 'Toma_De_Cinta', label: 'Toma de cinta', duration: '10 s' },
    { name: 'Paletizado_4_Posiciones', label: 'Paletizado', duration: '13,4 s' },
    { name: 'Demo_Ejes', label: 'Demo de ejes', duration: '17,6 s' },
  ],
  sliders: RIG.map((j) => ({ id: j.id, label: j.label, min: j.min, max: j.max, value: j.home, format: (v) => `${Math.round(v)}°` }))
    .concat([{ id: 'G1', label: 'G1 · Pinza', min: 0, max: 100, value: 100, format: (v) => (v > 90 ? 'abierta' : v < 10 ? 'cerrada' : `${Math.round(v)}%`) }]),
  onClip: (name) => play(name),
  onSlider: (id, v) => { stopClip(); if (id === 'G1') setGrip(v / 100); else setJoint(id, v); },
  footerHref: './Documentacion-Brazo-Industrial.html',
  footerLabel: 'Documentación del brazo →',
});

(function tick() {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();
  if (action) {
    mixer.update(dt);
    const vals = {};
    for (const j of RIG) vals[j.id] = j.node.rotation[j.axis] / deg(1);
    vals.G1 = ((Math.abs(fingers.R.node.position.x) - CLOSED) / (OPEN - CLOSED)) * 100;
    panel.sync(vals);
  }
})();

for (const j of RIG) setJoint(j.id, j.home);
setGrip(1);
play('Toma_De_Cinta');
panel.mark('Toma_De_Cinta');
