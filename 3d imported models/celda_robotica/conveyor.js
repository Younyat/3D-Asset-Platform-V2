/**
 * conveyor.js — CINTA TRANSPORTADORA INDUSTRIAL 2400 mm.
 * Objeto 3D independiente. Unidades: metros. Y arriba. Origen: centro de la
 * cinta a nivel del suelo (y=0). Transporte a lo largo del eje +X.
 * Altura de trabajo 0,80 m · ancho util 0,50 m · velocidad nominal 0,25 m/s.
 */
import * as THREE from 'three';
import { buildPanel } from './rig-ui.js';

const stage = document.querySelector('three-d-stage');
const { THREE: T } = await stage.ready;

/* materiales */
const mAlu   = new T.MeshStandardMaterial({ name: 'frame_alu', color: 0xd2d5d8, roughness: 0.32, metalness: 0.68 });
const mAluD  = new T.MeshStandardMaterial({ name: 'frame_alu_dark', color: 0xa9adb1, roughness: 0.38, metalness: 0.7 });
const mBelt  = new T.MeshStandardMaterial({ name: 'belt_rubber', color: 0x3b3d40, roughness: 0.82, metalness: 0.04 });
const mBolt  = new T.MeshStandardMaterial({ name: 'bolt_steel', color: 0x8f9397, roughness: 0.3, metalness: 0.85 });
const mPart  = new T.MeshStandardMaterial({ name: 'part_carton', color: 0xc8a06a, roughness: 0.72, metalness: 0.02 });

const root = new T.Group();
root.name = 'ConveyorBelt2400';

const LEN = 2.4, WID = 0.5, H = 0.80;      // largo · ancho util · altura de trabajo
const R_ROLL = 0.055;                       // radio de los tambores
const RAIL_H = 0.055;                       // alto del perfil lateral

const box = (w, h, d, mat, name) => { const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat); m.name = name; return m; };
const cyl = (r, h, mat, name, segs = 36) => { const m = new T.Mesh(new T.CylinderGeometry(r, r, h, segs), mat); m.name = name; return m; };

/* ---------- ESTRUCTURA fija: patas, bastidor, perfiles ---------- */
const frame = new T.Group(); frame.name = 'FRAME_fixed'; root.add(frame);

// bastidor longitudinal (dos perfiles de aluminio)
[-1, 1].forEach((s, i) => {
  const beam = box(LEN, 0.07, 0.035, mAlu, `frame_beam_${i}`);
  beam.position.set(0, H - RAIL_H - 0.055, s * (WID / 2 + 0.028));
  frame.add(beam);
  // perfil guia superior
  const rail = box(LEN, RAIL_H, 0.022, mAlu, `side_rail_${i}`);
  rail.position.set(0, H + RAIL_H / 2 - 0.008, s * (WID / 2 + 0.02));
  frame.add(rail);
  // soportes del perfil guia
  for (let k = 0; k < 5; k++) {
    const x = -LEN / 2 + 0.24 + k * ((LEN - 0.48) / 4);
    const brk = box(0.03, 0.05, 0.012, mAluD, `rail_bracket_${i}_${k}`);
    brk.position.set(x, H + 0.006, s * (WID / 2 + 0.037));
    frame.add(brk);
    const bolt = cyl(0.006, 0.016, mBolt, `rail_bolt_${i}_${k}`, 12);
    bolt.rotation.x = Math.PI / 2;
    bolt.position.set(x, H + 0.02, s * (WID / 2 + 0.046));
    frame.add(bolt);
  }
});

// travesanos
for (let k = 0; k < 4; k++) {
  const x = -LEN / 2 + 0.35 + k * ((LEN - 0.7) / 3);
  const cross = box(0.035, 0.05, WID + 0.03, mAluD, `cross_member_${k}`);
  cross.position.set(x, H - RAIL_H - 0.075, 0);
  frame.add(cross);
}

// patas con pie regulable
for (let k = 0; k < 3; k++) {
  const x = -LEN / 2 + 0.3 + k * ((LEN - 0.6) / 2);
  [-1, 1].forEach((s, i) => {
    const leg = cyl(0.018, H - 0.12, mAlu, `leg_${k}_${i}`, 20);
    leg.position.set(x, (H - 0.12) / 2 + 0.03, s * (WID / 2 + 0.02));
    frame.add(leg);
    const foot = cyl(0.038, 0.018, mAluD, `foot_${k}_${i}`, 24);
    foot.position.set(x, 0.009, s * (WID / 2 + 0.02));
    frame.add(foot);
    const nut = cyl(0.024, 0.014, mBolt, `foot_nut_${k}_${i}`, 6);
    nut.position.set(x, 0.026, s * (WID / 2 + 0.02));
    frame.add(nut);
  });
}

// cabezales de tambor (carcasas laterales)
[-1, 1].forEach((sx, i) => {
  const head = box(0.13, 0.14, WID + 0.09, mAlu, `drum_head_${i}`);
  head.position.set(sx * (LEN / 2 - 0.035), H - RAIL_H / 2 - 0.028, 0);
  frame.add(head);
  for (const [dy, dz] of [[0.038, 0.03], [-0.038, 0.03], [0.038, -0.03], [-0.038, -0.03]]) {
    const b = cyl(0.007, 0.014, mBolt, `head_bolt_${i}_${dy}_${dz}`, 10);
    b.rotation.x = Math.PI / 2;
    b.position.set(sx * (LEN / 2 - 0.035) + dz, H - RAIL_H / 2 - 0.028 + dy, (WID + 0.09) / 2);
    frame.add(b);
  }
});

/* ---------- BANDA: superficie con textura desplazable ---------- */
// textura procedural (canvas): caucho oscuro con nervadura transversal fina.
const tex = (() => {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#3b3d40'; g.fillRect(0, 0, 256, 64);
  for (let x = 0; x < 256; x += 16) {
    g.fillStyle = 'rgba(255,255,255,0.045)'; g.fillRect(x, 0, 2, 64);
    g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(x + 2, 0, 2, 64);
  }
  const t = new T.CanvasTexture(c);
  t.wrapS = t.wrapT = T.RepeatWrapping;
  t.repeat.set(LEN / 0.12, 1);
  t.colorSpace = T.SRGBColorSpace;
  return t;
})();
const mBeltTex = new T.MeshStandardMaterial({ name: 'belt_surface', map: tex, color: 0xffffff, roughness: 0.85, metalness: 0.03 });

const belt = new T.Group(); belt.name = 'BELT_surface'; root.add(belt);
const beltTop = box(LEN - 0.02, 0.008, WID, mBeltTex, 'belt_top');
beltTop.position.y = H; belt.add(beltTop);
const beltBottom = box(LEN - 0.02, 0.008, WID, mBelt, 'belt_return');
beltBottom.position.y = H - R_ROLL * 2; belt.add(beltBottom);
// curvatura de la banda en los extremos
[-1, 1].forEach((sx, i) => {
  const cap = new T.Mesh(new T.CylinderGeometry(R_ROLL + 0.004, R_ROLL + 0.004, WID, 28, 1, false, 0, Math.PI), mBelt);
  cap.name = `belt_wrap_${i}`;
  cap.rotation.set(Math.PI / 2, 0, sx > 0 ? -Math.PI / 2 : Math.PI / 2);
  cap.position.set(sx * (LEN / 2 - 0.01), H - R_ROLL, 0);
  belt.add(cap);
});

/* ---------- R1/R2 · tambores motriz y de retorno (giran en X) ---------- */
const R1 = new T.Group(); R1.name = 'R1_drive_roller';
R1.position.set(LEN / 2 - 0.01, H - R_ROLL, 0); root.add(R1);
const r1 = cyl(R_ROLL, WID - 0.006, mAluD, 'drive_roller_body', 28);
r1.rotation.x = Math.PI / 2; R1.add(r1);
const r1Key = box(0.012, R_ROLL * 1.9, 0.012, mBolt, 'drive_roller_key');
R1.add(r1Key);

const R2 = new T.Group(); R2.name = 'R2_idler_roller';
R2.position.set(-LEN / 2 + 0.01, H - R_ROLL, 0); root.add(R2);
const r2 = cyl(R_ROLL, WID - 0.006, mAluD, 'idler_roller_body', 28);
r2.rotation.x = Math.PI / 2; R2.add(r2);
const r2Key = box(0.012, R_ROLL * 1.9, 0.012, mBolt, 'idler_roller_key');
R2.add(r2Key);

/* ---------- S1 · tope neumatico (prismatico, Y) ---------- */
const S1 = new T.Group(); S1.name = 'S1_stopper';
S1.position.set(LEN / 2 - 0.42, H, 0); root.add(S1);
const blade = box(0.018, 0.09, WID * 0.8, mAluD, 'stopper_blade');
blade.position.y = 0.045; S1.add(blade);
const stopperBody = box(0.05, 0.09, 0.06, mAlu, 'stopper_actuator');
stopperBody.position.set(LEN / 2 - 0.42, H - 0.055, WID / 2 + 0.05); frame.add(stopperBody);

/* ---------- estacion de recogida (marco de referencia, sin geometria) ---------- */
const PICK = new T.Group(); PICK.name = 'PICK_STATION';
PICK.position.set(LEN / 2 - 0.42, H + 0.008, 0); root.add(PICK);
const INFEED = new T.Group(); INFEED.name = 'INFEED_STATION';
INFEED.position.set(-LEN / 2 + 0.25, H + 0.008, 0); root.add(INFEED);

/* ---------- P1..P4 · piezas transportadas (opcionales) ---------- */
const PART_COUNT = 4, PART_SPACING = LEN / PART_COUNT;
const parts = [];
const partsGroup = new T.Group(); partsGroup.name = 'PARTS_optional'; root.add(partsGroup);
for (let i = 0; i < PART_COUNT; i++) {
  const g = new T.Group(); g.name = `P${i + 1}_part`;
  const b = box(0.13, 0.1, 0.16, mPart, `part_box_${i + 1}`);
  b.position.y = 0.05; g.add(b);
  const tape = box(0.132, 0.006, 0.03, mAluD, `part_tape_${i + 1}`);
  tape.position.y = 0.1; g.add(tape);
  g.position.set(-LEN / 2 + 0.2 + i * PART_SPACING, H + 0.004, 0);
  partsGroup.add(g); parts.push(g);
}

/* ================= RIG ================= */
const SPEED_NOMINAL = 0.25;      // m/s
let speed = SPEED_NOMINAL;       // velocidad actual de la banda
let stopperUp = false;           // tope subido: retiene la pieza en PICK_STATION
let partsVisible = true;

const STOPPER_TRAVEL = 0.09;     // recorrido del tope (m)
const setStopper = (up) => { stopperUp = up; S1.position.y = H + (up ? 0 : -STOPPER_TRAVEL); };
const setSpeed = (v) => { speed = v; };
const setPartsVisible = (v) => { partsVisible = v; partsGroup.visible = v; };

/** Avance de la cinta: llamar cada frame con el delta en segundos. */
function advance(dt) {
  const d = speed * dt;
  tex.offset.x -= d / 0.12;                       // desplazamiento de la banda
  const angular = d / R_ROLL;                     // rodadura sin deslizamiento
  // los tambores son cilindros tumbados sobre Z: su eje de giro es Z, no X
  R1.rotation.z -= angular; R2.rotation.z -= angular;

  if (!partsVisible) return;
  const stopX = PICK.position.x;
  for (const p of parts) {
    let x = p.position.x + d;
    if (stopperUp && p.position.x <= stopX && x > stopX) x = stopX;   // retenida por el tope
    if (x > LEN / 2 + 0.2) x = -LEN / 2 - 0.2;                        // reentrada ciclica
    p.position.x = x;
  }
}

root.userData = {
  schema: 'conveyor-rig/1.0',
  asset: 'conveyor-belt-2400',
  units: 'meters', up: 'Y',
  transportAxis: '+X',
  lengthMeters: LEN, widthMeters: WID, workHeightMeters: H,
  nominalSpeedMetersPerSec: SPEED_NOMINAL, maxSpeedMetersPerSec: 0.6,
  rollerRadiusMeters: R_ROLL,
  frames: {
    PICK_STATION: [PICK.position.x, PICK.position.y, PICK.position.z],
    INFEED_STATION: [INFEED.position.x, INFEED.position.y, INFEED.position.z],
  },
  joints: [
    { name: 'R1_drive_roller', order: 'R1', type: 'continuous', axis: 'Z', relation: 'rotation.z -= distanceMeters / 0.055' },
    { name: 'R2_idler_roller', order: 'R2', type: 'continuous', axis: 'Z', relation: 'igual que R1' },
    { name: 'BELT_surface', order: 'C1', type: 'texture_offset', axis: 'U', relation: 'offset.u -= distanceMeters / 0.12' },
    { name: 'S1_stopper', order: 'S1', type: 'prismatic', axis: 'Y', limitsMeters: [H - 0.09, H], travelMeters: STOPPER_TRAVEL, actuationSec: 0.25 },
  ],
  parts: { group: 'PARTS_optional', count: PART_COUNT, spacingMeters: PART_SPACING, note: 'geometría de relleno; en producción la escena aporta sus propias piezas' },
  interop: {
    role: 'transport',
    handshake: ['PART_AT_STATION', 'STOPPER_UP', 'ROBOT_PICKING', 'PART_REMOVED', 'STOPPER_DOWN'],
    pairsWith: ['industrial-arm-6dof', 'cobot-6dof'],
  },
};

stage.setObject(root);

/* ================= panel ================= */
const clock = new T.Clock();
const panel = buildPanel(document.getElementById('rig-ui'), {
  title: 'Cinta transportadora · 2400 mm',
  clips: [
    { name: 'run', label: 'Marcha continua', duration: '0,25 m/s' },
    { name: 'index', label: 'Marcha indexada', duration: 'tope activo' },
    { name: 'stop', label: 'Parada', duration: '0 m/s' },
  ],
  sliders: [
    { id: 'speed', label: 'Velocidad banda', min: 0, max: 60, step: 1, value: SPEED_NOMINAL * 100, format: (v) => `${(v / 100).toFixed(2)} m/s` },
    { id: 'stopper', label: 'S1 · Tope', min: 0, max: 1, step: 1, value: 0, format: (v) => (v ? 'subido' : 'bajado') },
    { id: 'parts', label: 'Piezas de relleno', min: 0, max: 1, step: 1, value: 1, format: (v) => (v ? 'visibles' : 'ocultas') },
  ],
  onClip: (name) => {
    if (name === 'run') { setSpeed(SPEED_NOMINAL); setStopper(false); indexing = false; }
    if (name === 'index') { setSpeed(SPEED_NOMINAL); indexing = true; }
    if (name === 'stop') { setSpeed(0); indexing = false; }
    panel.sync({ speed: speed * 100, stopper: stopperUp ? 1 : 0 });
  },
  onSlider: (id, v) => {
    if (id === 'speed') { setSpeed(v / 100); indexing = false; }
    if (id === 'stopper') { setStopper(!!v); indexing = false; }
    if (id === 'parts') setPartsVisible(!!v);
  },
  footerHref: './Documentacion-Cinta.html',
  footerLabel: 'Documentación de la cinta →',
});

/* marcha indexada: el tope retiene 2,5 s en la estacion y libera 1,5 s */
let indexing = false, phase = 0;
setStopper(false);

(function tick() {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();
  if (indexing) {
    phase += dt;
    const up = phase % 4 < 2.5;
    if (up !== stopperUp) { setStopper(up); panel.sync({ stopper: up ? 1 : 0 }); }
  }
  advance(dt);
})();

panel.mark('run');
