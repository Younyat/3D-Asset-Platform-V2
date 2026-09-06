/**
 * cell-orchestrator.js — COORDINADOR DE CELDA (codigo de referencia).
 *
 * Los tres activos (cobot, brazo industrial, cinta) son archivos 3D
 * independientes. Este modulo NO forma parte de ninguno de ellos: es el
 * arbitro que los hace trabajar juntos cuando se cargan en la misma escena.
 *
 * Modelo: maquina de estados sobre un ciclo de 10 s con una unica pieza en
 * juego por vez. Cada activo publica y consume senales; nadie lee el estado
 * interno de otro.
 *
 *   import { Cell } from './cell-orchestrator.js';
 *
 *   const cell = new Cell({
 *     cobot:    { root: cobotGltf.scene,     mixer: cobotMixer,   THREE },
 *     arm:      { root: armGltf.scene,       mixer: armMixer,     THREE },
 *     conveyor: { root: conveyorGltf.scene,  THREE },
 *   });
 *   cell.start();
 *
 *   // bucle de render
 *   cell.update(clock.getDelta());
 */

/** Colocacion de la celda: el origen de coordenadas es el centro de la cinta. */
export const LAYOUT = {
  conveyor: { position: [0, 0, 0], rotationY: 0 },
  arm:      { position: [0.78, 0, -0.72], rotationY: Math.PI / 2 },   // frente a PICK_STATION
  cobot:    { position: [-0.95, 0, 0.50], rotationY: -Math.PI / 2 },  // frente a INFEED_STATION
};

/** Estaciones de la cinta, en coordenadas locales de la cinta. */
export const STATIONS = {
  INFEED: [-0.95, 0.808, 0],
  PICK:   [0.78, 0.808, 0],
};

/** Ciclo maestro de 10 s. t en segundos desde el inicio del ciclo. */
export const CYCLE = [
  { t: 0.0, signal: 'CYCLE_START',   actor: 'cell',     note: 'arranca el ciclo' },
  { t: 0.0, signal: 'COBOT_FEED',    actor: 'cobot',    note: 'el cobot deposita una pieza en INFEED' },
  { t: 1.2, signal: 'PART_ON_BELT',  actor: 'cobot',    note: 'pieza libre sobre la banda' },
  { t: 1.2, signal: 'BELT_RUN',      actor: 'conveyor', note: 'banda a 0,25 m/s' },
  { t: 2.0, signal: 'STOPPER_UP',    actor: 'conveyor', note: 'el tope sube antes de que llegue la pieza' },
  { t: 2.3, signal: 'PART_AT_PICK',  actor: 'conveyor', note: 'pieza retenida en PICK_STATION' },
  { t: 2.3, signal: 'ARM_PICK',      actor: 'arm',      note: 'el brazo inicia Toma_De_Cinta' },
  { t: 5.4, signal: 'PART_GRASPED',  actor: 'arm',      note: 'pinza cerrada · la pieza pasa a J6_tool_roll' },
  { t: 5.4, signal: 'STOPPER_DOWN',  actor: 'conveyor', note: 'el tope baja: la banda queda libre' },
  { t: 9.8, signal: 'PART_PLACED',   actor: 'arm',      note: 'pinza abierta en el palet' },
  { t: 10.0, signal: 'CYCLE_END',    actor: 'cell',     note: 'reinicio' },
];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Cell {
  constructor({ cobot, arm, conveyor, cycleSec = 10 }) {
    this.cobot = cobot; this.arm = arm; this.conveyor = conveyor;
    this.cycleSec = cycleSec;
    this.t = 0; this.running = false;
    this.fired = new Set();
    this.listeners = {};
    this.speedScale = 1;

    // 1 · colocar cada activo segun LAYOUT
    for (const [key, cfg] of Object.entries(LAYOUT)) {
      const a = this[key]; if (!a) continue;
      a.root.position.set(...cfg.position);
      a.root.rotation.y = cfg.rotationY;
    }

    // 2 · cachear los nodos de la cinta que se animan
    if (conveyor) {
      const c = conveyor.root;
      this.belt = c.getObjectByName('belt_top')?.material?.map || null;
      this.R1 = c.getObjectByName('R1_drive_roller');
      this.R2 = c.getObjectByName('R2_idler_roller');
      this.S1 = c.getObjectByName('S1_stopper');
      this.parts = ['P1_part', 'P2_part', 'P3_part', 'P4_part']
        .map((n) => c.getObjectByName(n)).filter(Boolean);
      this.beltSpeed = 0;
      this.stopperUp = false;
    }
  }

  on(signal, fn) { (this.listeners[signal] ||= []).push(fn); return this; }
  emit(signal, entry) { for (const fn of this.listeners[signal] || []) fn(entry, this); }

  start() { this.t = 0; this.fired.clear(); this.running = true; return this; }
  stop() { this.running = false; this.setBeltSpeed(0); return this; }

  /* ---------- acciones sobre cada activo ---------- */

  setBeltSpeed(v) { this.beltSpeed = v; }

  setStopper(up) {
    this.stopperUp = up;
    if (this.S1) this.S1.position.y = up ? 0.80 : 0.71;
  }

  playOn(actorKey, clipName, { loop = false } = {}) {
    const a = this[actorKey]; if (!a || !a.mixer) return null;
    const THREE = a.THREE;
    const clip = THREE.AnimationClip.findByName(a.root.animations || a.animations || [], clipName);
    if (!clip) { console.warn(`[cell] clip "${clipName}" no encontrado en ${actorKey}`); return null; }
    if (a.action) a.action.stop();
    a.action = a.mixer.clipAction(clip);
    a.action.reset();
    a.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    a.action.clampWhenFinished = true;
    a.action.play();
    return a.action;
  }

  /** Traspaso de pieza: reemparenta conservando la transformacion mundial. */
  attachPart(part, newParent) {
    if (!part || !newParent) return;
    newParent.attach ? newParent.attach(part) : newParent.add(part);
  }

  /* ---------- ciclo ---------- */

  update(dt) {
    const d = dt * this.speedScale;

    // avance de la cinta (paramétrico, no por keyframes)
    if (this.conveyor && this.beltSpeed) {
      const adv = this.beltSpeed * d;
      if (this.belt) this.belt.offset.x -= adv / 0.12;
      if (this.R1) this.R1.rotation.z -= adv / 0.055;   // eje de giro Z
      if (this.R2) this.R2.rotation.z -= adv / 0.055;
      const stopX = STATIONS.PICK[0];
      for (const p of this.parts) {
        let x = p.position.x + adv;
        if (this.stopperUp && p.position.x <= stopX && x > stopX) x = stopX;
        if (x > 1.4) x = -1.4;
        p.position.x = x;
      }
    }

    // mixers de los brazos
    for (const key of ['cobot', 'arm']) {
      const a = this[key];
      if (a && a.mixer) a.mixer.update(d);
    }

    if (!this.running) return;

    // disparo de señales del ciclo maestro
    const prev = this.t;
    this.t += d;
    for (const e of CYCLE) {
      const id = `${e.t}:${e.signal}`;
      if (this.fired.has(id)) continue;
      if (e.t > prev && e.t <= this.t) { this.fired.add(id); this.handle(e); this.emit(e.signal, e); }
    }
    if (this.t >= this.cycleSec) { this.t -= this.cycleSec; this.fired.clear(); }
  }

  /** Comportamiento por defecto de cada señal. Sobrescribir con on(). */
  handle(e) {
    switch (e.signal) {
      case 'COBOT_FEED':   this.playOn('cobot', 'Ciclo_Asistencia'); break;
      case 'BELT_RUN':     this.setBeltSpeed(0.25); break;
      case 'STOPPER_UP':   this.setStopper(true); break;
      case 'ARM_PICK':     this.playOn('arm', 'Toma_De_Cinta'); break;
      case 'STOPPER_DOWN': this.setStopper(false); break;
      default: break;
    }
  }

  /** Diagnostico: informa de lo que hay realmente cargado en la celda. */
  diagnose() {
    const r = {};
    for (const key of ['cobot', 'arm', 'conveyor']) {
      const a = this[key];
      r[key] = a ? {
        root: a.root.name,
        clips: (a.root.animations || []).map((c) => `${c.name} (${c.duration.toFixed(1)}s)`),
        schema: a.root.userData?.schema || 'ausente',
      } : 'no cargado';
    }
    r.conveyorNodes = this.conveyor
      ? { belt: !!this.belt, R1: !!this.R1, R2: !!this.R2, S1: !!this.S1, parts: this.parts.length }
      : null;
    return r;
  }
}

export { clamp };
