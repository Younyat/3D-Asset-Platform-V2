/**
 * viewer-boot.js — arranque común de los visores por objeto.
 * Carga un módulo de modelo, lo monta en <three-d-stage> y construye el
 * panel de control desde MODEL.joints y MODEL.clips. Un solo archivo sirve
 * para los cinco modelos porque todos cumplen el mismo contrato.
 */
import { buildPanel } from './rig-ui.js';

export async function boot({ module, docHref, docLabel, title, create: createFn, opts = {} }) {
  const stage = document.querySelector('three-d-stage');
  const { THREE } = await stage.ready;

  const mod = await import(module);
  const MODEL = mod.MODEL;
  const factory = createFn ? mod[createFn] : mod.create;
  const inst = factory(THREE, opts);

  stage.setObject(inst.root);

  const clips = (MODEL.clips || []).map((c) => ({
    name: c.name,
    label: c.name.replace(/_/g, ' '),
    duration: `${c.duration.toFixed(1).replace('.', ',')} s`,
  }));

  const sliders = (MODEL.joints || []).map((j) => {
    const lo = Number.isFinite(j.limits?.[0]) ? j.limits[0] : -360;
    const hi = Number.isFinite(j.limits?.[1]) ? j.limits[1] : 360;
    const isM = j.unit === 'm' || j.unit === 'm/s';
    return {
      id: j.id, label: j.label,
      min: isM ? Math.round(lo * 100) : lo,
      max: isM ? Math.round(hi * 100) : hi,
      step: 1,
      value: isM ? Math.round((j.home ?? 0) * 100) : (j.home ?? 0),
      format: isM ? (v) => `${(v / 100).toFixed(2)} ${j.unit}`
                  : (v) => `${Math.round(v)}${j.unit === '°' ? '°' : ' ' + (j.unit || '')}`,
      _scale: isM ? 0.01 : 1,
    };
  });

  const panel = buildPanel(document.getElementById('rig-ui'), {
    title: title || MODEL.label,
    clips, sliders,
    onClip: (name) => inst.playClip(name, { loop: (MODEL.clips.find((c) => c.name === name) || {}).loop !== false }),
    onSlider: (id, v) => {
      inst.stopClip();
      const s = sliders.find((x) => x.id === id);
      inst.setJoint(id, v * (s?._scale ?? 1));
    },
    footerHref: docHref, footerLabel: docLabel,
  });

  const clock = new THREE.Clock();
  (function tick() {
    requestAnimationFrame(tick);
    inst.update(clock.getDelta());
    if (inst.action) {
      const vals = {};
      for (const s of sliders) {
        const v = inst.getJoint(s.id);
        if (v !== undefined) vals[s.id] = v / (s._scale ?? 1);
      }
      panel.sync(vals);
    }
  })();

  if (clips.length) { inst.playClip(clips[0].name); panel.mark(clips[0].name); }

  window.__model = inst;      // para inspección desde la consola
  return inst;
}
