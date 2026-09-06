/**
 * rig-ui.js — panel de control compartido por los visores (cobot, brazo
 * industrial, cinta). Es solo herramienta de inspeccion: NO forma parte de
 * ningun rig ni se exporta con los modelos. Cada objeto 3D es independiente.
 */

export function buildPanel(host, { title, clips = [], joints = [], sliders = [], onClip, onSlider, footerHref, footerLabel }) {
  host.innerHTML = '';
  const el = (tag, style, html) => { const n = document.createElement(tag); if (style) n.style.cssText = style; if (html != null) n.innerHTML = html; return n; };
  const H2 = (t) => el('div', 'font:600 10px/1.2 "IBM Plex Sans",system-ui,sans-serif;letter-spacing:.13em;text-transform:uppercase;color:#8c8781;margin-bottom:8px', t);

  Object.assign(host.style, {
    position: 'fixed', top: '20px', left: '20px', width: '250px', zIndex: 10,
    background: 'rgba(24,25,27,0.9)', backdropFilter: 'blur(8px)', color: '#e9e6e1',
    border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '16px',
    font: '12px/1.5 "IBM Plex Sans", system-ui, sans-serif', display: 'flex',
    flexDirection: 'column', gap: '16px', maxHeight: 'calc(100vh - 40px)', overflowY: 'auto',
  });

  if (title) host.appendChild(el('div', 'font:600 13px/1.3 "IBM Plex Sans",system-ui,sans-serif;color:#fff', title));

  const buttons = [];
  if (clips.length) {
    const sec = el('div');
    sec.appendChild(H2('Animaciones'));
    const stack = el('div', 'display:flex;flex-direction:column;gap:6px');
    for (const c of clips) {
      const b = el('button', 'font:inherit;text-align:left;cursor:pointer;color:#e9e6e1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:7px;padding:7px 10px', `${c.label} · ${c.duration}`);
      b.type = 'button';
      b.onmouseenter = () => { if (!b.dataset.on) b.style.background = 'rgba(255,255,255,.13)'; };
      b.onmouseleave = () => { if (!b.dataset.on) b.style.background = 'rgba(255,255,255,.06)'; };
      b.onclick = () => { mark(c.name); onClip && onClip(c.name); };
      b.dataset.clip = c.name;
      buttons.push(b); stack.appendChild(b);
    }
    sec.appendChild(stack); host.appendChild(sec);
  }
  function mark(name) {
    for (const b of buttons) {
      const on = b.dataset.clip === name;
      if (on) { b.dataset.on = '1'; b.style.background = '#d9520c'; b.style.borderColor = '#d9520c'; }
      else { delete b.dataset.on; b.style.background = 'rgba(255,255,255,.06)'; b.style.borderColor = 'rgba(255,255,255,.1)'; }
    }
  }

  const outs = {};
  if (sliders.length) {
    const sec = el('div');
    sec.appendChild(H2('Control manual'));
    const stack = el('div', 'display:flex;flex-direction:column;gap:9px');
    for (const s of sliders) {
      const row = el('div', 'display:flex;flex-direction:column;gap:3px');
      const lab = el('label', 'display:flex;justify-content:space-between;color:#c9c4bd;font-size:11.5px', `<span>${s.label}</span>`);
      const out = el('span', 'color:#8c8781;font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums');
      out.textContent = s.format ? s.format(s.value) : s.value;
      lab.appendChild(out); row.appendChild(lab);
      const input = el('input', 'width:100%;accent-color:#d9520c');
      Object.assign(input, { type: 'range', min: s.min, max: s.max, step: s.step ?? 1, value: s.value });
      input.oninput = () => {
        const v = +input.value;
        out.textContent = s.format ? s.format(v) : v;
        mark(null);
        onSlider && onSlider(s.id, v);
      };
      row.appendChild(input); stack.appendChild(row);
      outs[s.id] = { input, out, def: s };
    }
    sec.appendChild(stack); host.appendChild(sec);
  }

  if (footerHref) {
    const a = el('a', 'color:#e8b400;text-decoration:none;font-size:11.5px', footerLabel || 'Documentación →');
    a.href = footerHref;
    a.onmouseenter = () => { a.style.textDecoration = 'underline'; };
    a.onmouseleave = () => { a.style.textDecoration = 'none'; };
    host.appendChild(a);
  }

  return {
    mark,
    /** Refresca los valores mostrados (p. ej. mientras corre un clip). */
    sync(values) {
      for (const [id, v] of Object.entries(values)) {
        const o = outs[id]; if (!o) continue;
        o.input.value = v;
        o.out.textContent = o.def.format ? o.def.format(v) : Math.round(v);
      }
    },
  };
}
