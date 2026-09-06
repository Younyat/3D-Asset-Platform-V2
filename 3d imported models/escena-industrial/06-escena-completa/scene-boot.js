/**
 * scene-boot.js — ESCENA INDUSTRIAL COMPLETA + EDITOR DE SUSTITUCIÓN.
 *
 * Carga los seis modelos, los coloca según LAYOUT y hace correr el ciclo
 * maestro. El editor lateral permite quitar, volver a poner y sustituir
 * cualquier objeto EN VIVO, sin recargar: es la demostración de que los
 * modelos son intercambiables porque todos cumplen el mismo contrato.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ===================== COLOCACIÓN DE LA CELDA =====================
   Origen del mundo: centro de la máquina de inspección, a nivel del suelo.
   El flujo de material va en +X. */
export const LAYOUT = {
  machine:    { module: '../02-maquina-inspeccion/inspection-machine.js', pos: [0, 0, 0],        rotY: 0,        label: 'Máquina de inspección' },
  conveyorA:  { module: '../03-cinta-transportadora/conveyor-segment.js',   pos: [-2.30, 0, 0],    rotY: 0,        label: 'Cinta · tramo A (entrada)', opts: { length: 3.25, label: 'A' } },
  conveyorB:  { module: '../03-cinta-transportadora/conveyor-segment.js',   pos: [2.40, 0, 0],     rotY: 0,        label: 'Cinta · tramo B (salida)',  opts: { length: 3.45, label: 'B' } },
  gantry:     { module: '../01-portico-robot/gantry-robot.js',       pos: [-4.35, 0, -1.15], rotY: -0.785,   label: 'Pórtico robot · 5 ejes' },
  operator:   { module: '../04-operario/operator.js',           pos: [0.30, 0, 1.22],  rotY: Math.PI / 2, label: 'Operario' },
  boxStack:   { module: '../05-caja-y-pila/cargo-box.js',          pos: [4.55, 0, 1.55],  rotY: 0.18,     label: 'Pila de cajas', create: 'createStack', opts: { rows: 2, cols: 3, depth: 2 } },
};

/* ===================== CICLO MAESTRO (12 s) ===================== */
export const CYCLE_SEC = 12;
export const CYCLE = [
  { t: 0.0,  signal: 'CYCLE_START',  actor: 'scene',     note: 'arranca el ciclo' },
  { t: 0.0,  signal: 'GANTRY_PICK',  actor: 'gantry',    note: 'el pórtico toma una caja de la pila' },
  { t: 4.8,  signal: 'BOX_ON_BELT',  actor: 'gantry',    note: 'la caja queda sobre la cinta A' },
  { t: 4.8,  signal: 'BELT_A_RUN',   actor: 'conveyorA', note: 'cinta A a 0,30 m/s' },
  { t: 6.4,  signal: 'BOX_ENTERING', actor: 'machine',   note: 'la caja abre la cortina del túnel' },
  { t: 7.0,  signal: 'OPERATOR_ACK', actor: 'operator',  note: 'el operario valida en el panel' },
  { t: 8.6,  signal: 'BELT_B_RUN',   actor: 'conveyorB', note: 'la caja sale del túnel a la cinta B' },
  { t: 9.4,  signal: 'INSPECTION_OK', actor: 'machine',  note: 'baliza en verde' },
  { t: 12.0, signal: 'CYCLE_END',    actor: 'scene',     note: 'reinicio' },
];
// El evento de cierre coincide con el reinicio: se dispara justo antes del corte.
CYCLE[CYCLE.length - 1].t = CYCLE_SEC - 0.001;

/* ===================== ESCENA ===================== */
const view = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#eceae6');

const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
camera.position.set(8.6, 6.2, 8.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.03;

scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b4ad, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.position.set(6, 9, 5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 0.5, far: 32 });
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.5);
fill.position.set(-7, 4, -5); scene.add(fill);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: 0xf4f2ee, roughness: 0.95, metalness: 0 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  if (!w || !h) return;                 // evita camera.aspect = NaN antes del layout
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
// ResizeObserver en vez de una medida única + evento window: dispara ya con la
// caja real y en cada cambio del contenedor, aunque la ventana no cambie.
new ResizeObserver(resize).observe(view);

/* ===================== REGISTRO DE OBJETOS =====================
   El registro es el corazón de la flexibilidad: guarda una entrada por
   ranura (slot). Quitar = dispose + borrar la entrada. Sustituir = quitar
   y montar otro módulo en la misma ranura, con la misma colocación. */
const registry = new Map();

async function mount(slot, cfg) {
  const mod = await import(cfg.module);
  const factory = cfg.create ? mod[cfg.create] : mod.create;
  const inst = factory(THREE, cfg.opts || {});
  inst.root.position.set(...cfg.pos);
  inst.root.rotation.y = cfg.rotY || 0;
  inst.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(inst.root);
  registry.set(slot, { inst, cfg });
  return inst;
}

function unmount(slot) {
  const e = registry.get(slot);
  if (!e) return false;
  e.inst.dispose();
  registry.delete(slot);
  return true;
}

async function replace(slot, cfg) {
  const prev = registry.get(slot);
  const keep = prev ? prev.cfg : {};
  unmount(slot);
  return mount(slot, { ...keep, ...cfg });
}

const get = (slot) => registry.get(slot)?.inst || null;

/* ===================== CARGA INICIAL ===================== */
for (const [slot, cfg] of Object.entries(LAYOUT)) await mount(slot, cfg);

/* cajas viajeras: una por tramo, entregadas a la cinta como carga */
const boxMod = await import('../05-caja-y-pila/cargo-box.js');
const travellers = [];
function spawnBox(slot, x) {
  const conv = get(slot); if (!conv) return null;
  const b = boxMod.create(THREE, {});
  b.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  b.root.position.set(x, conv.model.beltHeight + 0.01, 0);
  conv.root.add(b.root);
  conv.addCargo(b.root);
  travellers.push({ inst: b, slot });
  return b;
}
[-1.1, 0.1, 1.2].forEach((x) => spawnBox('conveyorA', x));
[-1.2, 0.2, 1.4].forEach((x) => spawnBox('conveyorB', x));

/* ===================== CICLO MAESTRO ===================== */
let t = 0, running = true, fired = new Set(), speedScale = 1;

function handle(e) {
  const g = get('gantry'), m = get('machine'), o = get('operator');
  const a = get('conveyorA'), b = get('conveyorB');
  switch (e.signal) {
    case 'GANTRY_PICK':   g?.signal('PICK'); break;
    case 'BELT_A_RUN':    a?.signal('RUN', 0.30); break;
    case 'BOX_ENTERING':  m?.signal('BOX_ENTERING'); break;
    case 'OPERATOR_ACK':  o?.signal('PRESS'); break;
    case 'BELT_B_RUN':    b?.signal('RUN', 0.30); break;
    case 'INSPECTION_OK': m?.signal('RUN'); break;
    default: break;
  }
  log(`${e.t.toFixed(1).padStart(4)}s  ${e.signal}`, e.actor);
}

/* ===================== EDITOR ===================== */
const SUBSTITUTES = {
  gantry: [
    { label: 'Pórtico robot · 5 ejes', module: '../01-portico-robot/gantry-robot.js' },
  ],
  conveyorA: [
    { label: 'Tramo 3,25 m (original)', module: '../03-cinta-transportadora/conveyor-segment.js', opts: { length: 3.25, label: 'A' } },
    { label: 'Tramo corto 2,20 m', module: '../03-cinta-transportadora/conveyor-segment.js', opts: { length: 2.20, label: 'A' } },
    { label: 'Tramo largo 4,30 m', module: '../03-cinta-transportadora/conveyor-segment.js', opts: { length: 4.30, label: 'A' } },
  ],
  conveyorB: [
    { label: 'Tramo 3,45 m (original)', module: '../03-cinta-transportadora/conveyor-segment.js', opts: { length: 3.45, label: 'B' } },
    { label: 'Tramo corto 2,40 m', module: '../03-cinta-transportadora/conveyor-segment.js', opts: { length: 2.40, label: 'B' } },
  ],
  boxStack: [
    { label: 'Pila 2×3×2 (original)', module: '../05-caja-y-pila/cargo-box.js', create: 'createStack', opts: { rows: 2, cols: 3, depth: 2 } },
    { label: 'Pila alta 3×3×2', module: '../05-caja-y-pila/cargo-box.js', create: 'createStack', opts: { rows: 3, cols: 3, depth: 2 } },
    { label: 'Pila baja 1×4×2', module: '../05-caja-y-pila/cargo-box.js', create: 'createStack', opts: { rows: 1, cols: 4, depth: 2 } },
    { label: 'Una sola caja', module: '../05-caja-y-pila/cargo-box.js' },
  ],
  machine: [{ label: 'Máquina de inspección', module: '../02-maquina-inspeccion/inspection-machine.js' }],
  operator: [{ label: 'Operario articulado', module: '../04-operario/operator.js' }],
};

const rows = document.getElementById('slots');
function buildEditor() {
  rows.innerHTML = '';
  for (const [slot, cfg] of Object.entries(LAYOUT)) {
    const present = registry.has(slot);
    const row = document.createElement('div');
    row.className = 'slot' + (present ? '' : ' off');

    const head = document.createElement('div');
    head.className = 'slot-head';
    head.innerHTML = `<span class="dot"></span><span class="nm">${cfg.label}</span>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toggle';
    btn.textContent = present ? 'Quitar' : 'Poner';
    btn.onclick = async () => {
      if (registry.has(slot)) unmount(slot);
      else await mount(slot, registry.get(slot)?.cfg || LAYOUT[slot]);
      buildEditor();
    };
    head.appendChild(btn);
    row.appendChild(head);

    const alts = SUBSTITUTES[slot] || [];
    if (alts.length > 1) {
      const sel = document.createElement('select');
      for (const a of alts) {
        const op = document.createElement('option');
        op.value = a.label; op.textContent = a.label; sel.appendChild(op);
      }
      const cur = registry.get(slot)?.cfg;
      if (cur?._alt) sel.value = cur._alt;
      sel.onchange = async () => {
        const a = alts.find((x) => x.label === sel.value);
        await replace(slot, { ...LAYOUT[slot], module: a.module, create: a.create, opts: a.opts, _alt: a.label });
        if (slot.startsWith('conveyor')) reseedCargo(slot);
        buildEditor();
      };
      row.appendChild(sel);
    }
    rows.appendChild(row);
  }
}

function reseedCargo(slot) {
  const conv = get(slot); if (!conv) return;
  for (let i = travellers.length - 1; i >= 0; i--) {
    if (travellers[i].slot === slot) { travellers[i].inst.dispose(); travellers.splice(i, 1); }
  }
  const L = conv.LEN;
  [-L * 0.34, 0.04, L * 0.36].forEach((x) => spawnBox(slot, x));
}

/* consola de señales */
const logEl = document.getElementById('log');
function log(line, actor) {
  const d = document.createElement('div');
  d.innerHTML = `<b>${actor}</b> ${line}`;
  logEl.prepend(d);
  while (logEl.children.length > 14) logEl.lastChild.remove();
}

document.getElementById('play').onclick = (e) => {
  running = !running;
  e.target.textContent = running ? 'Pausar ciclo' : 'Reanudar ciclo';
  e.target.classList.toggle('on', running);
};
document.getElementById('restart').onclick = () => { t = 0; fired.clear(); logEl.innerHTML = ''; };
document.getElementById('speed').oninput = (e) => {
  speedScale = +e.target.value / 100;
  document.getElementById('speedv').textContent = `${speedScale.toFixed(2)}×`;
};
document.getElementById('diag').onclick = () => {
  const r = {};
  for (const [slot, e] of registry) r[slot] = e.inst.diagnose();
  console.table(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { id: v.id, clips: v.clips.join(' · ') }])));
  console.log(r);
  log('diagnose() → consola del navegador', 'scene');
};

buildEditor();

/* ===================== BUCLE DE RENDER ===================== */
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta() * speedScale;

  // UN SOLO RELOJ para todos los objetos de la escena
  for (const { inst } of registry.values()) inst.update(dt);
  for (const { inst } of travellers) inst.update(dt);

  if (running) {
    const prev = t; t += dt;
    // Detector de flanco INCLUSIVO en t = 0: las señales del instante 0 son
    // las que arrancan el ciclo, y con `e.t > prev` nunca se dispararian.
    for (const e of CYCLE) {
      const id = `${e.t}:${e.signal}`;
      if (fired.has(id)) continue;
      if (e.t >= prev && e.t < t) { fired.add(id); handle(e); }
    }
    if (t >= CYCLE_SEC) { t = 0; fired.clear(); }
    document.getElementById('clock').textContent = `${t.toFixed(1).replace('.', ',')} s`;
  }

  controls.update();
  renderer.render(scene, camera);
});

/* acceso desde la consola */
window.__scene = { scene, registry, mount, unmount, replace, get, LAYOUT, CYCLE };
