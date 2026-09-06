/**
 * cobot-arm.js — COBOT COLABORATIVO DE 6 EJES (naranja).
 * Objeto 3D independiente. Unidades: metros. Y arriba. Origen en la base, y=0.
 * Alcance ~0,92 m · carga nominal 5 kg · sin herramienta (brida libre).
 */
import * as THREE from 'three';
import { buildPanel } from './rig-ui.js';

const stage = document.querySelector('three-d-stage');
const { THREE: T } = await stage.ready;
const deg = T.MathUtils.degToRad;

/* materiales */
const mOrange = new T.MeshStandardMaterial({ name: 'cobot_orange', color: 0xe2650d, roughness: 0.38, metalness: 0.12 });
const mDark   = new T.MeshStandardMaterial({ name: 'joint_charcoal', color: 0x2b2d31, roughness: 0.46, metalness: 0.22 });
const mGrey   = new T.MeshStandardMaterial({ name: 'flange_alu', color: 0xb9bcc0, roughness: 0.3, metalness: 0.7 });
const mSeal   = new T.MeshStandardMaterial({ name: 'joint_seal', color: 0x17181a, roughness: 0.8, metalness: 0.05 });

const root = new T.Group();
root.name = 'CollaborativeArm6DOF';
root.userData = { model: 'CB-5 cobot', payloadKg: 5, reachMeters: 0.92 };

/* helpers */
const cyl = (r1, r2, h, mat, name, segs = 40) => {
  const m = new T.Mesh(new T.CylinderGeometry(r1, r2, h, segs), mat); m.name = name; return m;
};
/** carcasa de articulacion: tambor tumbado sobre el eje X con tapas oscuras */
function jointDrum(radius, length, mat, name) {
  const g = new T.Group(); g.name = name;
  const body = cyl(radius, radius, length, mat, name + '_body');
  body.rotation.x = Math.PI / 2; g.add(body);
  [-1, 1].forEach((s, i) => {
    const cap = cyl(radius * 1.02, radius * 1.02, 0.012, mSeal, `${name}_cap_${i}`);
    cap.rotation.x = Math.PI / 2; cap.position.z = s * (length / 2 - 0.004); g.add(cap);
  });
  return g;
}
/** tubo de eslabon con codo redondeado en el extremo */
function linkTube(radius, length, mat, name) {
  const g = new T.Group(); g.name = name;
  const tube = cyl(radius, radius * 0.96, length, mat, name + '_tube');
  tube.position.y = length / 2; g.add(tube);
  const knee = new T.Mesh(new T.SphereGeometry(radius * 0.99, 32, 20), mat);
  knee.name = name + '_knee'; knee.position.y = length; g.add(knee);
  return g;
}

/* ---------- BASE fija ---------- */
const base = new T.Group(); base.name = 'BASE_fixed'; root.add(base);
const foot = cyl(0.105, 0.115, 0.028, mDark, 'base_disc'); foot.position.y = 0.014; base.add(foot);
const pedestal = cyl(0.082, 0.098, 0.085, mDark, 'base_pedestal'); pedestal.position.y = 0.07; base.add(pedestal);
for (let i = 0; i < 4; i++) {
  const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
  const bolt = cyl(0.008, 0.008, 0.014, mGrey, `base_bolt_${i}`, 12);
  bolt.position.set(Math.cos(a) * 0.09, 0.032, Math.sin(a) * 0.09); base.add(bolt);
}

/* ---------- J1 · rotacion de base (Y) ---------- */
const J1 = new T.Group(); J1.name = 'J1_base_rotate'; J1.position.y = 0.112; base.add(J1);
const j1Shell = cyl(0.079, 0.079, 0.078, mOrange, 'j1_shell'); j1Shell.position.y = 0.039; J1.add(j1Shell);
const j1Seal = cyl(0.081, 0.081, 0.008, mSeal, 'j1_seal'); J1.add(j1Seal);

/* ---------- J2 · elevacion de hombro (Z) ---------- */
const J2 = new T.Group(); J2.name = 'J2_shoulder_lift'; J2.position.y = 0.078; J1.add(J2);
J2.add(jointDrum(0.076, 0.152, mDark, 'j2_drum'));
const upper = linkTube(0.058, 0.355, mOrange, 'upper_arm'); J2.add(upper);

/* ---------- J3 · codo (Z) ---------- */
const J3 = new T.Group(); J3.name = 'J3_elbow'; J3.position.y = 0.355; J2.add(J3);
J3.add(jointDrum(0.064, 0.128, mDark, 'j3_drum'));
const fore = linkTube(0.049, 0.305, mOrange, 'forearm'); J3.add(fore);

/* ---------- J4 · muneca 1, cabeceo (Z) ---------- */
const J4 = new T.Group(); J4.name = 'J4_wrist_1'; J4.position.y = 0.305; J3.add(J4);
J4.add(jointDrum(0.05, 0.1, mDark, 'j4_drum'));
const w1 = cyl(0.044, 0.044, 0.072, mOrange, 'wrist_1_shell'); w1.position.y = 0.036; J4.add(w1);

/* ---------- J5 · muneca 2, guinada (X) ---------- */
const J5 = new T.Group(); J5.name = 'J5_wrist_2'; J5.position.y = 0.072; J4.add(J5);
const j5drum = jointDrum(0.045, 0.09, mDark, 'j5_drum'); j5drum.rotation.y = Math.PI / 2; J5.add(j5drum);
const w2 = cyl(0.04, 0.04, 0.064, mOrange, 'wrist_2_shell'); w2.position.y = 0.032; J5.add(w2);

/* ---------- J6 · muneca 3, giro de herramienta (Y) ---------- */
const J6 = new T.Group(); J6.name = 'J6_wrist_3'; J6.position.y = 0.064; J5.add(J6);
const w3 = cyl(0.037, 0.037, 0.03, mDark, 'wrist_3_shell'); w3.position.y = 0.015; J6.add(w3);

/* brida de herramienta ISO 9409-1-50-4-M6 (punto de montaje) */
const TCP = new T.Group(); TCP.name = 'TOOL_FLANGE'; TCP.position.y = 0.03; J6.add(TCP);
const flange = cyl(0.0315, 0.0315, 0.008, mGrey, 'tool_flange'); flange.position.y = 0.004; TCP.add(flange);
for (let i = 0; i < 4; i++) {
  const a = (i / 4) * Math.PI * 2;
  const hole = cyl(0.003, 0.003, 0.01, mSeal, `flange_hole_${i}`, 10);
  hole.position.set(Math.cos(a) * 0.0225, 0.005, Math.sin(a) * 0.0225); TCP.add(hole);
}

/* ================= RIG ================= */
const RIG = [
  { id: 'J1', node: J1, name: 'J1_base_rotate',   axis: 'y', label: 'J1 · Base',      min: -360, max: 360, speed: 180, home: 0 },
  { id: 'J2', node: J2, name: 'J2_shoulder_lift', axis: 'z', label: 'J2 · Hombro',    min: -175, max: 175, speed: 180, home: -35 },
  { id: 'J3', node: J3, name: 'J3_elbow',         axis: 'z', label: 'J3 · Codo',      min: -160, max: 160, speed: 180, home: 75 },
  { id: 'J4', node: J4, name: 'J4_wrist_1',       axis: 'z', label: 'J4 · Muñeca 1',  min: -175, max: 175, speed: 225, home: 50 },
  { id: 'J5', node: J5, name: 'J5_wrist_2',       axis: 'x', label: 'J5 · Muñeca 2',  min: -175, max: 175, speed: 225, home: 0 },
  { id: 'J6', node: J6, name: 'J6_wrist_3',       axis: 'y', label: 'J6 · Muñeca 3',  min: -360, max: 360, speed: 225, home: 0 },
];
const byId = Object.fromEntries(RIG.map((j) => [j.id, j]));
const setJoint = (id, d) => {
  const j = byId[id]; const v = T.MathUtils.clamp(d, j.min, j.max);
  j.node.rotation[j.axis] = deg(v); return v;
};

/* ================= CLIPS ================= */
const P = (t, J1, J2, J3, J4, J5, J6) => ({ t, J1, J2, J3, J4, J5, J6 });

// Ciclo de asistencia: recoge de la mesa (izquierda) y presenta a la celda (derecha).
const ASISTENCIA = [
  P(0.0,  0,   -35, 75,  50,  0,   0),
  P(1.4,  -55, -10, 85,  25,  0,   0),
  P(2.4,  -55, 15,  80,  -5,  0,   0),
  P(3.2,  -55, 15,  80,  -5,  0,   90),
  P(4.0,  -55, -10, 85,  25,  0,   90),
  P(5.6,  50,  -10, 85,  25,  0,   90),
  P(6.6,  50,  15,  80,  -5,  30,  90),
  P(7.6,  50,  15,  80,  -5,  30,  -90),
  P(8.4,  50,  -10, 85,  25,  0,   -90),
  P(10.0, 0,   -35, 75,  50,  0,   0),
];

// Guiado manual: pose fluida de ensenanza, movimiento lento y continuo.
const GUIADO = [
  P(0.0, 0,   -35, 75,  50,  0,   0),
  P(2.0, 25,  -60, 110, 40,  35,  45),
  P(4.0, -20, -5,  60,  70,  -30, -60),
  P(6.0, 0,   -35, 75,  50,  0,   0),
];

// Verificacion de ejes: cada eje barre su rango util en orden.
const DEMO = [
  P(0.0,  0,    -35, 75,  50,  0,    0),
  P(1.6,  -175, -35, 75,  50,  0,    0),
  P(4.0,  175,  -35, 75,  50,  0,    0),
  P(5.4,  0,    -35, 75,  50,  0,    0),
  P(6.4,  0,    -120, 75, 50,  0,    0),
  P(7.4,  0,    60,  75,  50,  0,    0),
  P(8.4,  0,    -35, 150, 50,  0,    0),
  P(9.4,  0,    -35, -60, 50,  0,    0),
  P(10.4, 0,    -35, 75,  160, 0,    0),
  P(11.4, 0,    -35, 75,  -120, 0,   0),
  P(12.4, 0,    -35, 75,  50,  160,  0),
  P(13.4, 0,    -35, 75,  50,  -160, 0),
  P(14.4, 0,    -35, 75,  50,  0,    270),
  P(15.6, 0,    -35, 75,  50,  0,    -270),
  P(16.6, 0,    -35, 75,  50,  0,    0),
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
  return new T.AnimationClip(name, times[times.length - 1], tracks);
}

const clips = [
  buildClip('Ciclo_Asistencia', ASISTENCIA),
  buildClip('Guiado_Manual', GUIADO),
  buildClip('Demo_Ejes', DEMO),
];
root.animations = clips;

root.userData = {
  ...root.userData,
  schema: 'robot-arm-rig/1.1',
  asset: 'cobot-6dof',
  units: 'meters', up: 'Y', toolFrame: 'TOOL_FLANGE',
  toolMount: 'ISO 9409-1-50-4-M6',
  joints: RIG.map((j) => ({
    name: j.name, order: j.id, type: 'revolute', axis: j.axis.toUpperCase(),
    limitsDeg: [j.min, j.max], maxSpeedDegPerSec: j.speed, homeDeg: j.home,
  })),
  clips: clips.map((c) => ({ name: c.name, durationSec: +c.duration.toFixed(2), loop: c.name !== 'Guiado_Manual' })),
  interop: { role: 'assist', handoffFrame: 'TOOL_FLANGE', pairsWith: ['industrial-arm-6dof', 'conveyor-belt-2400'] },
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
  title: 'Cobot colaborativo · 6 ejes',
  clips: [
    { name: 'Ciclo_Asistencia', label: 'Ciclo de asistencia', duration: '10 s' },
    { name: 'Guiado_Manual', label: 'Guiado manual', duration: '6 s' },
    { name: 'Demo_Ejes', label: 'Demo de ejes', duration: '16,6 s' },
  ],
  sliders: RIG.map((j) => ({ id: j.id, label: j.label, min: j.min, max: j.max, value: j.home, format: (v) => `${Math.round(v)}°` })),
  onClip: (name) => play(name),
  onSlider: (id, v) => { stopClip(); setJoint(id, v); },
  footerHref: './Documentacion-Cobot.html',
  footerLabel: 'Documentación del cobot →',
});

(function tick() {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();
  if (action) {
    mixer.update(dt);
    const vals = {};
    for (const j of RIG) vals[j.id] = j.node.rotation[j.axis] / deg(1);
    panel.sync(vals);
  }
})();

for (const j of RIG) setJoint(j.id, j.home);
play('Ciclo_Asistencia');
panel.mark('Ciclo_Asistencia');
