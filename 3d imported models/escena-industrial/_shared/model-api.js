/**
 * model-api.js — CONTRATO COMÚN DE TODOS LOS MODELOS DE LA ESCENA.
 *
 * Cada modelo de la escena industrial (pórtico, máquina, cinta, operario,
 * caja) es un módulo independiente que exporta exactamente lo mismo:
 *
 *     export const MODEL = { ...metadatos... };
 *     export function create(THREE, opts) -> instancia
 *
 * Una instancia expone SIEMPRE la misma superficie:
 *
 *     root        THREE.Group        el objeto para añadir a la escena
 *     model       objeto MODEL       metadatos (joints, clips, huella)
 *     setJoint(id, value)            escribe un eje (grados o metros)
 *     getJoint(id)                   lee el valor actual de un eje
 *     playClip(name, {loop})         reproduce una animación
 *     stopClip()                     libera los ejes para control manual
 *     update(dt)                     avance por frame (SIEMPRE llamarlo)
 *     signal(name, payload)          entrada de señal externa
 *     dispose()                      libera geometrías y materiales
 *
 * Por eso los objetos son intercambiables: la plataforma puede quitar un
 * modelo y poner otro sin cambiar una línea del código que los maneja,
 * mientras el sustituto implemente este mismo contrato.
 */

export const CONTRACT_VERSION = '1.0';

/** Tipos de eje admitidos en MODEL.joints. */
export const JOINT_TYPES = {
  revolute: 'rotación limitada · valor en grados',
  continuous: 'rotación sin límite · valor acumulado en grados',
  prismatic: 'traslación limitada · valor en metros',
  discrete: 'estados discretos · valor entero (índice)',
  channel: 'canal no geométrico (luz, pantalla, textura) · valor 0..1',
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const DEG = Math.PI / 180;

/**
 * Clase base que implementa el contrato. Cada modelo la extiende y solo
 * construye su geometría y declara sus ejes: el control manual, los clips,
 * los límites y el diagnóstico ya vienen resueltos aquí.
 */
export class ModelBase {
  constructor(THREE, model, opts = {}) {
    this.THREE = THREE;
    this.model = model;
    this.opts = opts;
    this.root = new THREE.Group();
    this.root.name = model.rootName;
    this.root.userData = { ...model, contract: CONTRACT_VERSION };

    this.jointDefs = Object.fromEntries(model.joints.map((j) => [j.id, j]));
    this.nodes = {};              // id -> THREE.Object3D
    this.values = {};             // id -> valor actual
    this.mixer = null;
    this.action = null;
    this._clips = [];
    this._listeners = {};
    this.speedScale = 1;
  }

  /* ---------- ejes ---------- */

  /** Registra el nodo que materializa un eje declarado. */
  bind(id, node) {
    if (!this.jointDefs[id]) throw new Error(`[${this.model.id}] eje "${id}" no declarado en MODEL.joints`);
    this.nodes[id] = node;
    this.values[id] = this.jointDefs[id].home ?? 0;
    return node;
  }

  /** Declara un eje de tipo channel/discrete, que no necesita nodo. */
  bindChannel(id) {
    if (!this.jointDefs[id]) throw new Error(`[${this.model.id}] eje "${id}" no declarado en MODEL.joints`);
    this.nodes[id] = null;
    this.values[id] = this.jointDefs[id].home ?? 0;
    return this;
  }

  /**
   * Escribe UN eje. Recorta a límites y aplica la ÚNICA componente que
   * corresponde al tipo y eje declarados. Nunca toca otras componentes.
   */
  setJoint(id, value) {
    const d = this.jointDefs[id];
    if (!d) return undefined;
    const isGeom = d.type === 'revolute' || d.type === 'continuous' || d.type === 'prismatic';
    const node = this.nodes[id];
    if (isGeom && !node) return undefined;
    const axis = (d.axis || 'Y').toLowerCase();
    let v = value;

    if (d.type === 'revolute') {
      v = clamp(v, d.limits[0], d.limits[1]);
      node.rotation[axis] = v * DEG;
    } else if (d.type === 'continuous') {
      node.rotation[axis] = v * DEG;
    } else if (d.type === 'prismatic') {
      v = clamp(v, d.limits[0], d.limits[1]);
      node.position[axis] = (d.origin?.[axis] ?? 0) + v;
    } else if (d.type === 'discrete') {
      v = Math.round(clamp(v, 0, d.states.length - 1));
      d.apply?.(this, v);
    } else if (d.type === 'channel') {
      v = clamp(v, d.limits?.[0] ?? 0, d.limits?.[1] ?? 1);
      d.apply?.(this, v);
    }
    this.values[id] = v;
    return v;
  }

  getJoint(id) { return this.values[id]; }

  /** Aplica una pose completa: { id: valor, ... } */
  setPose(pose) {
    for (const [id, v] of Object.entries(pose)) if (id in this.jointDefs) this.setJoint(id, v);
    return this;
  }

  goHome() {
    for (const j of this.model.joints) this.setJoint(j.id, j.home ?? 0);
    return this;
  }

  /* ---------- clips ---------- */

  /**
   * Construye clips de AnimationClip desde tablas de poses.
   * poses: [{ t, <jointId>: valor, ... }]
   */
  buildClip(name, poses) {
    const T = this.THREE;
    const times = poses.map((p) => p.t);
    const tracks = [];
    const q = new T.Quaternion(), e = new T.Euler();

    for (const j of this.model.joints) {
      if (!(j.id in poses[0])) continue;
      const node = this.nodes[j.id];
      if (!node) continue;
      const axis = (j.axis || 'Y').toLowerCase();

      if (j.type === 'revolute' || j.type === 'continuous') {
        const values = [];
        for (const p of poses) {
          const raw = p[j.id];
          const a = (j.type === 'revolute' ? clamp(raw, j.limits[0], j.limits[1]) : raw) * DEG;
          e.set(axis === 'x' ? a : 0, axis === 'y' ? a : 0, axis === 'z' ? a : 0);
          q.setFromEuler(e);
          values.push(q.x, q.y, q.z, q.w);
        }
        tracks.push(new T.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, values));
      } else if (j.type === 'prismatic') {
        const values = [];
        for (const p of poses) {
          const v = clamp(p[j.id], j.limits[0], j.limits[1]);
          const pos = { x: node.position.x, y: node.position.y, z: node.position.z };
          pos[axis] = (j.origin?.[axis] ?? 0) + v;
          values.push(pos.x, pos.y, pos.z);
        }
        tracks.push(new T.VectorKeyframeTrack(`${node.name}.position`, times, values));
      }
    }

    const clip = new T.AnimationClip(name, times[times.length - 1], tracks);
    this._clips.push(clip);
    this.root.animations = this._clips;
    return clip;
  }

  playClip(name, { loop = true } = {}) {
    const T = this.THREE;
    if (!this.mixer) this.mixer = new T.AnimationMixer(this.root);
    const clip = this._clips.find((c) => c.name === name);
    if (!clip) { console.warn(`[${this.model.id}] clip "${name}" no existe`); return null; }
    if (this.action) this.action.stop();
    this.action = this.mixer.clipAction(clip);
    this.action.reset();
    this.action.setLoop(loop ? T.LoopRepeat : T.LoopOnce, Infinity);
    this.action.clampWhenFinished = true;
    this.action.play();
    this.activeClip = name;
    return this.action;
  }

  /** Detiene el clip y sincroniza los valores con la pose real alcanzada. */
  stopClip() {
    if (!this.action) return this;
    this.action.stop(); this.action = null; this.activeClip = null;
    for (const j of this.model.joints) {
      const node = this.nodes[j.id]; if (!node) continue;
      const axis = (j.axis || 'Y').toLowerCase();
      if (j.type === 'revolute' || j.type === 'continuous') this.values[j.id] = node.rotation[axis] / DEG;
      else if (j.type === 'prismatic') this.values[j.id] = node.position[axis] - (j.origin?.[axis] ?? 0);
    }
    return this;
  }

  /* ---------- por frame ---------- */

  /** Los modelos con movimiento paramétrico sobrescriben tick(dt). */
  tick(dt) {}

  update(dt) {
    const d = dt * this.speedScale;
    if (this.mixer && this.action) this.mixer.update(d);
    this.tick(d);
    return this;
  }

  /* ---------- señales ---------- */

  on(name, fn) { (this._listeners[name] ||= []).push(fn); return this; }
  emit(name, payload) { for (const fn of this._listeners[name] || []) fn(payload, this); }

  /** Entrada de señal externa. Cada modelo declara las que entiende. */
  signal(name, payload) {
    const h = this.model.signals?.[name];
    if (h) h(this, payload);
    this.emit(name, payload);
    return this;
  }

  /* ---------- utilidades ---------- */

  diagnose() {
    return {
      id: this.model.id,
      root: this.root.name,
      joints: Object.fromEntries(this.model.joints.map((j) => [j.id,
        j.type === 'channel' || j.type === 'discrete' ? (j.id in this.values) : !!this.nodes[j.id]])),
      clips: this._clips.map((c) => `${c.name} (${c.duration.toFixed(1)}s)`),
      values: { ...this.values },
    };
  }

  dispose() {
    this.root.traverse((o) => {
      o.geometry?.dispose?.();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose?.()); else m?.dispose?.();
    });
    this.root.parent?.remove(this.root);
  }
}

/** Ayudas de geometría compartidas por los modelos. */
export function makeHelpers(THREE) {
  const box = (w, h, d, mat, name) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.name = name; return m;
  };
  const cyl = (r1, r2, h, mat, name, seg = 32) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, seg), mat); m.name = name; return m;
  };
  const sph = (r, mat, name, seg = 24) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.round(seg * 0.6)), mat); m.name = name; return m;
  };
  /** Marco rectangular hueco (pata en U invertida de la cinta). */
  const frame = (w, h, t, d, mat, name) => {
    const g = new THREE.Group(); g.name = name;
    const top = box(w, t, d, mat, name + '_top'); top.position.y = h - t / 2; g.add(top);
    [-1, 1].forEach((s, i) => {
      const leg = box(t, h - t, d, mat, `${name}_leg_${i}`);
      leg.position.set(s * (w / 2 - t / 2), (h - t) / 2, 0); g.add(leg);
    });
    return g;
  };
  return { box, cyl, sph, frame };
}

export { clamp, DEG };
