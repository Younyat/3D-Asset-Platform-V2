/**
 * conveyor-segment.js — TRAMO DE CINTA TRANSPORTADORA
 * Objeto independiente y modular. Metros · Y arriba.
 * Origen: centro del tramo a nivel del suelo (y = 0). Transporte en +X.
 *
 * La escena usa dos instancias: A (entrada, 3,25 m) y B (salida, 3,45 m).
 * El movimiento es PARAMÉTRICO (velocidad en m/s), no por keyframes.
 */
import { ModelBase, makeHelpers } from '../_shared/model-api.js';

const H = 0.85;          // altura de la banda
const WID = 0.62;        // ancho útil
const R_ROLL = 0.075;    // radio de tambor
const PITCH = 0.14;      // paso de nervadura de la banda

export const MODEL = {
  id: 'conveyor-segment',
  version: '1.0',
  label: 'Tramo de cinta',
  rootName: 'ConveyorSegment',
  units: 'meters',
  up: 'Y',
  contractRole: 'transport',
  footprint: { length: 3.25, width: WID, height: H },
  transportAxis: '+X',
  beltHeight: H,
  rollerRadius: R_ROLL,
  beltPitch: PITCH,
  nominalSpeed: 0.30,
  maxSpeed: 0.80,
  palette: { frame: 0xe6e7e9, belt: 0x3a3b3d, steel: 0xb8bcc0, dark: 0x2a2c2f },

  joints: [
    { id: 'R1', name: 'R1_drive_roller', type: 'continuous', axis: 'Z', label: 'R1 · Tambor motriz',
      limits: [-Infinity, Infinity], home: 0, unit: '°',
      moves: 'Cilindro tumbado sobre Z: gira sobre Z. rotation.z -= d / 0,075 con d = v·dt.' },
    { id: 'R2', name: 'R2_idler_roller', type: 'continuous', axis: 'Z', label: 'R2 · Tambor de retorno',
      limits: [-Infinity, Infinity], home: 0, unit: '°',
      moves: 'Misma velocidad angular que R1: rodadura sin deslizamiento.' },
    { id: 'S1', name: 'S1_stopper', type: 'prismatic', axis: 'Y', label: 'S1 · Tope de retención',
      limits: [-0.11, 0], speed: 0.44, home: -0.11, unit: 'm',
      moves: 'Sube (0) para retener la caja en la estación y baja (−0,11) para liberarla.' },
    { id: 'C1', name: 'BELT_surface', type: 'channel', axis: 'U', label: 'C1 · Velocidad de banda',
      limits: [0, 0.80], home: 0.30, unit: 'm/s',
      apply: (m, v) => { m.speed = v; },
      moves: 'Canal de velocidad. De él se derivan el desplazamiento de textura, los tambores y el avance de las cajas.' },
  ],

  clips: [],   // sin keyframes: movimiento paramétrico

  signals: {
    RUN: (m, v) => m.setJoint('C1', v ?? MODEL.nominalSpeed),
    STOP: (m) => m.setJoint('C1', 0),
    STOPPER_UP: (m) => m.setJoint('S1', 0),
    STOPPER_DOWN: (m) => m.setJoint('S1', -0.11),
  },

  frames: { INFEED: [-1.3, H + 0.01, 0], OUTFEED: [1.3, H + 0.01, 0], STATION: [0.95, H + 0.01, 0] },

  interop: {
    provides: ['BOX_AT_STATION', 'BOX_AT_OUTFEED'],
    consumes: ['RUN', 'STOP', 'STOPPER_UP', 'STOPPER_DOWN'],
    pairsWith: ['gantry-robot-5axis', 'inspection-machine', 'cargo-box'],
  },
};

export function create(THREE, opts = {}) {
  return new ConveyorSegment(THREE, opts);
}

class ConveyorSegment extends ModelBase {
  /** opts: { length = 3.25, stopperAt = 0.95, label } */
  constructor(THREE, opts) {
    const model = { ...MODEL, footprint: { ...MODEL.footprint, length: opts.length ?? 3.25 } };
    super(THREE, model, opts);
    const T = THREE;
    const { box, cyl, frame } = makeHelpers(T);
    const P = MODEL.palette;
    const LEN = opts.length ?? 3.25;
    this.LEN = LEN;
    this.stopperAt = opts.stopperAt ?? (LEN / 2 - 0.65);
    if (opts.label) this.root.name = `ConveyorSegment_${opts.label}`;

    const mFrame = new T.MeshStandardMaterial({ name: 'conv_frame', color: P.frame, roughness: 0.46, metalness: 0.12 });
    const mFrameD = new T.MeshStandardMaterial({ name: 'conv_frame_shade', color: 0xd2d4d7, roughness: 0.5, metalness: 0.12 });
    const mSteel = new T.MeshStandardMaterial({ name: 'conv_steel', color: P.steel, roughness: 0.3, metalness: 0.7 });
    const mBeltPlain = new T.MeshStandardMaterial({ name: 'conv_belt', color: P.belt, roughness: 0.85, metalness: 0.04 });

    // textura de banda: caucho oscuro con nervadura transversal
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 64;
    const g2 = canvas.getContext('2d');
    g2.fillStyle = '#3a3b3d'; g2.fillRect(0, 0, 256, 64);
    for (let x = 0; x < 256; x += 18) {
      g2.fillStyle = 'rgba(255,255,255,0.05)'; g2.fillRect(x, 0, 2, 64);
      g2.fillStyle = 'rgba(0,0,0,0.20)'; g2.fillRect(x + 2, 0, 3, 64);
    }
    const tex = new T.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.repeat.set(LEN / PITCH, 1);
    tex.colorSpace = T.SRGBColorSpace;
    this.tex = tex;
    const mBelt = new T.MeshStandardMaterial({ name: 'conv_belt_surface', map: tex, roughness: 0.86, metalness: 0.03 });

    /* ---------- estructura fija ---------- */
    const fixed = new T.Group(); fixed.name = 'FRAME_fixed'; this.root.add(fixed);

    // vigas laterales
    [-1, 1].forEach((s, i) => {
      const beam = box(LEN, 0.10, 0.045, mFrame, `side_beam_${i}`);
      beam.position.set(0, H - 0.10, s * (WID / 2 + 0.032));
      fixed.add(beam);
      const skirt = box(LEN, 0.055, 0.018, mFrameD, `side_skirt_${i}`);
      skirt.position.set(0, H + 0.028, s * (WID / 2 + 0.028));
      fixed.add(skirt);
    });

    // patas en U invertida (como en la ilustración)
    const legCount = Math.max(2, Math.round(LEN / 1.6));
    for (let k = 0; k < legCount; k++) {
      const x = -LEN / 2 + 0.55 + k * ((LEN - 1.1) / Math.max(1, legCount - 1));
      const u = frame(WID + 0.30, H - 0.14, 0.055, 0.055, mFrame, `leg_frame_${k}`);
      u.position.set(x, 0, 0); u.rotation.y = Math.PI / 2;
      fixed.add(u);
      for (const s of [-1, 1]) {
        const foot = box(0.09, 0.014, 0.09, mFrameD, `foot_${k}_${s}`);
        foot.position.set(x, 0.007, s * (WID + 0.30) / 2);
        fixed.add(foot);
      }
    }

    /* ---------- banda ---------- */
    const belt = new T.Group(); belt.name = 'BELT_surface'; this.root.add(belt);
    const top = box(LEN - 0.02, 0.01, WID, mBelt, 'belt_top');
    top.position.y = H; belt.add(top);
    const ret = box(LEN - 0.02, 0.01, WID, mBeltPlain, 'belt_return');
    ret.position.y = H - R_ROLL * 2; belt.add(ret);
    [-1, 1].forEach((sx, i) => {
      // media envolvente del tambor: eje Z (rotation.x = 90°) y la mitad
      // orientada hacia fuera mediante thetaStart, no con una segunda rotación.
      const wrap = new T.Mesh(
        new T.CylinderGeometry(R_ROLL + 0.005, R_ROLL + 0.005, WID, 26, 1, false,
          sx > 0 ? 0 : Math.PI, Math.PI),
        mBeltPlain,
      );
      wrap.name = `belt_wrap_${i}`;
      wrap.rotation.x = Math.PI / 2;
      wrap.position.set(sx * (LEN / 2 - 0.01), H - R_ROLL, 0);
      belt.add(wrap);
    });
    this.beltNode = belt;

    /* ---------- R1 / R2 · tambores (eje Z) ---------- */
    const mkRoller = (name, x) => {
      const g = new T.Group(); g.name = name;
      g.position.set(x, H - R_ROLL, 0); this.root.add(g);
      const body = cyl(R_ROLL, R_ROLL, WID - 0.004, mSteel, name + '_body', 26);
      body.rotation.x = Math.PI / 2; g.add(body);
      [-1, 1].forEach((s, i) => {
        const cap = cyl(R_ROLL * 1.06, R_ROLL * 1.06, 0.012, mFrameD, `${name}_cap_${i}`, 26);
        cap.rotation.x = Math.PI / 2; cap.position.z = s * (WID / 2 - 0.004); g.add(cap);
      });
      const key = box(0.012, R_ROLL * 1.85, 0.012, mFrameD, name + '_key');
      g.add(key);
      return g;
    };
    this.bind('R1', mkRoller('R1_drive_roller', LEN / 2 - 0.01));
    this.bind('R2', mkRoller('R2_idler_roller', -LEN / 2 + 0.01));

    /* ---------- S1 · tope ---------- */
    const S1 = new T.Group(); S1.name = 'S1_stopper';
    S1.position.set(this.stopperAt, H, 0); this.root.add(S1);
    this.bind('S1', S1);
    this.model.joints.find((j) => j.id === 'S1').origin = { y: H };
    const blade = box(0.02, 0.11, WID * 0.78, mSteel, 'stopper_blade');
    blade.position.y = 0.055; S1.add(blade);
    const act = box(0.06, 0.11, 0.07, mFrame, 'stopper_actuator');
    act.position.set(this.stopperAt, H - 0.065, WID / 2 + 0.07); fixed.add(act);

    /* ---------- marcos de referencia ---------- */
    for (const [name, off] of [['INFEED', -LEN / 2 + 0.35], ['OUTFEED', LEN / 2 - 0.35], ['STATION', this.stopperAt]]) {
      const f = new T.Group(); f.name = `${name}_FRAME`;
      f.position.set(off, H + 0.01, 0); this.root.add(f);
    }

    this.speed = MODEL.nominalSpeed;
    this.cargo = [];     // objetos que la cinta transporta (añadidos por la escena)
    this.bindChannel('C1');
    this.goHome();
    this.setJoint('C1', MODEL.nominalSpeed);
  }

  /** Registra una caja para que la cinta la haga avanzar. */
  addCargo(obj) { if (!this.cargo.includes(obj)) this.cargo.push(obj); return this; }
  removeCargo(obj) { this.cargo = this.cargo.filter((o) => o !== obj); return this; }

  tick(dt) {
    const d = this.speed * dt;
    if (!d) return;
    this.tex.offset.x -= d / MODEL.beltPitch;
    const ang = d / R_ROLL;
    this.nodes.R1.rotation.z -= ang;          // eje de giro Z
    this.nodes.R2.rotation.z -= ang;

    const held = this.getJoint('S1') > -0.05;  // tope arriba
    const stopX = this.stopperAt - 0.24;
    for (const o of this.cargo) {
      let x = o.position.x + d;
      if (held && o.position.x <= stopX && x > stopX) x = stopX;
      if (x > this.LEN / 2 + 0.4) { x = -this.LEN / 2 - 0.4; this.emit('BOX_RECYCLED', o); }
      if (o.position.x <= stopX && x >= stopX) this.emit('BOX_AT_STATION', o);
      o.position.x = x;
    }
  }
}
