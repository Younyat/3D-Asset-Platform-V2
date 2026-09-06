/**
 * cargo-box.js — CAJA DE CARTÓN + PILA CONFIGURABLE
 * Dos modelos independientes en un módulo. Metros · Y arriba.
 * Origen de la caja: centro de su base (y = 0), para apoyar sin cálculo.
 */
import { ModelBase, makeHelpers } from '../_shared/model-api.js';

const W = 0.42, HH = 0.34, D = 0.36;   // ancho (X) · alto (Y) · fondo (Z)

export const MODEL = {
  id: 'cargo-box',
  version: '1.0',
  label: 'Caja de cartón',
  rootName: 'CargoBox',
  units: 'meters',
  up: 'Y',
  contractRole: 'payload',
  footprint: { width: W, height: HH, depth: D },
  mass: 4.5,
  graspWidth: W,
  palette: { carton: 0xc79e68, cartonShade: 0xb08a56, tape: 0xd9bd93, label: 0xf7f5f1, ink: 0x6b6a67 },
  joints: [
    { id: 'L1', name: 'L1_lid_hinge', type: 'revolute', axis: 'Z', label: 'L1 · Tapa',
      limits: [0, 105], speed: 120, home: 0, unit: '°',
      moves: 'Abre la tapa superior sobre su bisagra en el borde −X. 0° cerrada · 105° abierta.' },
  ],
  clips: [
    { name: 'Abrir_Tapa', duration: 1.2, loop: false, does: 'Apertura de la tapa.' },
  ],
  signals: {
    OPEN: (m) => m.setJoint('L1', 105),
    CLOSE: (m) => m.setJoint('L1', 0),
  },
  interop: { provides: [], consumes: ['OPEN', 'CLOSE'], pairsWith: ['conveyor-segment', 'gantry-robot-5axis'] },
};

export const STACK_MODEL = {
  id: 'cargo-box-stack',
  version: '1.0',
  label: 'Pila de cajas',
  rootName: 'CargoBoxStack',
  units: 'meters',
  up: 'Y',
  contractRole: 'payload_group',
  footprint: { width: 1.34, height: 0.70, depth: 0.86 },
  palette: MODEL.palette,
  joints: [],
  clips: [],
  signals: {},
  interop: { provides: ['BOX_AVAILABLE'], consumes: ['TAKE_BOX', 'ADD_BOX'], pairsWith: ['gantry-robot-5axis'] },
  config: { rows: 2, cols: 3, depth: 2, jitter: 0.02 },
};

/* ---------- materiales compartidos (una sola instancia para N cajas) ---------- */
let SHARED = null;
function materials(THREE) {
  if (SHARED) return SHARED;
  const P = MODEL.palette;
  // etiqueta procedural: rectángulo blanco con líneas de código
  const c = document.createElement('canvas'); c.width = 128; c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = '#f7f5f1'; g.fillRect(0, 0, 128, 96);
  g.fillStyle = '#6b6a67';
  for (let i = 0; i < 5; i++) g.fillRect(12, 14 + i * 12, 104 - (i % 2) * 26, 4);
  for (let i = 0; i < 22; i++) g.fillRect(12 + i * 5, 74, 1 + (i % 3), 12);
  const labelTex = new THREE.CanvasTexture(c);
  labelTex.colorSpace = THREE.SRGBColorSpace;

  SHARED = {
    carton: new THREE.MeshStandardMaterial({ name: 'box_carton', color: P.carton, roughness: 0.78, metalness: 0.02 }),
    cartonShade: new THREE.MeshStandardMaterial({ name: 'box_carton_shade', color: P.cartonShade, roughness: 0.8, metalness: 0.02 }),
    tape: new THREE.MeshStandardMaterial({ name: 'box_tape', color: P.tape, roughness: 0.62, metalness: 0.02 }),
    label: new THREE.MeshStandardMaterial({ name: 'box_label', map: labelTex, roughness: 0.7, metalness: 0.01 }),
  };
  return SHARED;
}

/** Geometría de una caja, sin joints: reutilizable dentro de la pila. */
function buildBoxMesh(THREE, M) {
  const { box } = makeHelpers(THREE);
  const g = new THREE.Group(); g.name = 'box_body';

  const body = box(W, HH, D, M.carton, 'box_carton_body');
  body.position.y = HH / 2; g.add(body);

  // solapas de la tapa (dos rectángulos que dejan la junta central)
  [-1, 1].forEach((s, i) => {
    const flap = box(W * 0.5 - 0.004, 0.008, D, M.cartonShade, `box_flap_${i}`);
    flap.position.set(s * W * 0.25, HH + 0.004, 0); g.add(flap);
  });
  // cinta de precinto longitudinal
  const tape = box(W + 0.004, 0.006, 0.085, M.tape, 'box_tape_strip');
  tape.position.y = HH + 0.009; g.add(tape);
  // aristas: refuerzo visual en las cuatro verticales
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    const edge = box(0.012, HH * 0.98, 0.012, M.cartonShade, `box_edge_${sx}_${sz}`);
    edge.position.set(sx * (W / 2 - 0.006), HH / 2, sz * (D / 2 - 0.006)); g.add(edge);
  }
  // etiqueta en la cara +Z
  const label = box(0.13, 0.10, 0.004, M.label, 'box_label');
  label.position.set(0.06, HH * 0.5, D / 2 + 0.002); g.add(label);

  return g;
}

export function create(THREE, opts = {}) { return new CargoBox(THREE, opts); }
export function createStack(THREE, opts = {}) { return new CargoBoxStack(THREE, opts); }

class CargoBox extends ModelBase {
  constructor(THREE, opts) {
    super(THREE, MODEL, opts);
    const M = materials(THREE);
    const body = buildBoxMesh(THREE, M);
    this.root.add(body);

    // L1 · tapa articulada: bisagra en el borde −X, al nivel superior
    const L1 = new THREE.Group(); L1.name = 'L1_lid_hinge';
    L1.position.set(-W / 2, HH + 0.008, 0);
    this.root.add(L1);
    this.bind('L1', L1);
    const { box } = makeHelpers(THREE);
    const lid = box(W, 0.01, D, M.cartonShade, 'lid_panel');
    lid.position.set(W / 2, 0, 0); L1.add(lid);
    body.getObjectByName('box_flap_0').visible = false;
    body.getObjectByName('box_flap_1').visible = false;

    this.buildClip('Abrir_Tapa', [{ t: 0, L1: 0 }, { t: 1.2, L1: 105 }]);
    this.goHome();
  }
}

class CargoBoxStack extends ModelBase {
  /** opts: { rows, cols, depth, jitter } */
  constructor(THREE, opts) {
    const cfg = { ...STACK_MODEL.config, ...opts };
    super(THREE, { ...STACK_MODEL, config: cfg }, opts);
    const M = materials(THREE);
    this.boxes = [];
    const GX = W + 0.03, GZ = D + 0.03, GY = HH + 0.012;

    for (let r = 0; r < cfg.rows; r++) {
      // la hilera superior de la ilustración tiene una caja menos
      const cols = r === cfg.rows - 1 ? Math.max(1, cfg.cols - 1) : cfg.cols;
      for (let c = 0; c < cols; c++) {
        for (let d = 0; d < cfg.depth; d++) {
          const g = buildBoxMesh(THREE, M);
          g.name = `box_r${r}_c${c}_d${d}`;
          const jx = (Math.sin(r * 7.1 + c * 3.3 + d) * cfg.jitter);
          const jz = (Math.cos(r * 4.7 + c * 2.9 + d * 1.7) * cfg.jitter);
          g.position.set(
            (c - (cols - 1) / 2) * GX + jx,
            r * GY,
            (d - (cfg.depth - 1) / 2) * GZ + jz,
          );
          g.rotation.y = (Math.sin(r * 2.3 + c + d * 5) * 0.05);
          this.root.add(g);
          this.boxes.push(g);
        }
      }
    }
    this.model.signals = {
      TAKE_BOX: (m) => { const b = m.boxes.pop(); if (b) { m.root.remove(b); m.emit('BOX_TAKEN', b); } return b; },
      ADD_BOX: (m, obj) => { if (obj) { m.root.add(obj); m.boxes.push(obj); } },
    };
  }

  /** Devuelve la caja superior y la quita de la pila (para el pórtico). */
  takeTop() { return this.signal('TAKE_BOX'); }
  get count() { return this.boxes.length; }
}
