// Response curve editor: one per stick. Points sit at fixed input positions; drag them up or
// down (or type a value). The line drawn through them is a smooth curve that never folds back.
// Values travel as 0..65535 (x0, y0, x1, y1 ...).

const SZ = 300;        // plot size in svg units
const PAD = 30;
const PRESETS = {
  Linear: (x) => x,
  Precise: (x) => x ** 1.6,      // finer near centre
  Fast: (x) => x ** 0.7,         // quicker start
  'S-curve': (x) => (x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) ** 2),
};

// Smooth curve through (xs, ys) that never folds back: returns f(x) for x in 0..1
export function monotone(xs, ys) {
  const n = xs.length;
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    let k = 0;
    while (k < n - 2 && x > xs[k + 1]) k++;
    const hgt = xs[k + 1] - xs[k];
    const u = (x - xs[k]) / hgt;
    const u2 = u * u;
    const u3 = u2 * u;
    const v = (2 * u3 - 3 * u2 + 1) * ys[k] + (u3 - 2 * u2 + u) * hgt * m[k]
      + (-2 * u3 + 3 * u2) * ys[k + 1] + (u3 - u2) * hgt * m[k + 1];
    return Math.min(1, Math.max(0, v));
  };
}

const px = (x) => PAD + x * SZ;
const py = (y) => PAD + (1 - y) * SZ;

let editors = [];

// infos: [left setting, right setting] (SETTING_INFO fields plus .data from GET_SETTING)
// save(setting, data[]) -> Promise<status string>
export function initCurves(host, infos, save, restore) {
  host.innerHTML = '<div class="editors"></div><div class="row"><button data-act="copy">Copy left to right</button></div>';
  const box = host.querySelector('.editors');
  editors = infos.map((s, i) => makeEditor(box, s, i ? 'Right stick' : 'Left stick', save, restore));
  host.querySelector('[data-act=copy]').addEventListener('click', async () => {
    if (editors.length < 2) return;
    editors[1].set(editors[0].xs.slice(), editors[0].ys.slice());
    await editors[1].commit();
  });
}

const MAX_INNER = 10;   // adjustable points: 1..10, plus the two fixed ends

function makeEditor(box, setting, title, save, restore) {
  const el = document.createElement('div');
  el.className = 'editor';
  const xs = [];
  const ys = [];
  for (let i = 0; i + 1 < setting.data.length; i += 2) { xs.push(setting.data[i] / 65535); ys.push(setting.data[i + 1] / 65535); }
  const ed = { xs, ys, setting };

  el.innerHTML = `<div class="row" style="margin-top:0;justify-content:space-between">
      <h3 style="margin:0">${title}</h3>
      <select aria-label="Curve preset">${['Custom', ...Object.keys(PRESETS)].map((p) => `<option>${p}</option>`).join('')}</select>
    </div>
    <div class="tools">
      <label>Points <select data-t="count" aria-label="Adjustable points">${[...Array(MAX_INNER).keys()]
        .map((i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select></label>
      <button data-t="restore">Restore default</button>
    </div>
    <svg viewBox="0 0 ${SZ + 2 * PAD} ${SZ + 2 * PAD}">
      <defs><linearGradient id="hotgrad-e" x1="0" x2="1"><stop offset="0" stop-color="#ff8a1f"/><stop offset="1" stop-color="#e82035"/></linearGradient></defs>
      ${[...Array(9).keys()].map((k) => `<line class="grid-line" x1="${px(k / 8)}" y1="${py(0)}" x2="${px(k / 8)}" y2="${py(1)}"/>
        <line class="grid-line" x1="${px(0)}" y1="${py(k / 8)}" x2="${px(1)}" y2="${py(k / 8)}"/>`).join('')}
      <rect class="frame" x="${px(0)}" y="${py(1)}" width="${SZ}" height="${SZ}"/>
      <line class="ref" x1="${px(0)}" y1="${py(0)}" x2="${px(1)}" y2="${py(1)}"/>
      <path class="shape-line" fill="none" style="fill:none"/>
      <g class="pts"></g>
      <circle class="live" r="5" cx="-20" cy="-20"/>
      <text class="lbl" x="${px(0)}" y="${py(0) + 18}">0</text><text class="lbl" x="${px(1) - 22}" y="${py(0) + 18}">100 %</text>
      <text class="lbl" x="${px(0) - 26}" y="${py(1) + 4}">100</text>
    </svg>
    <div class="pts-row"></div>
    <p class="muted small" style="margin:6px 0 0">Input along the bottom, output up the side. Drag a point or type its output %.</p>`;
  box.appendChild(el);
  const svg = el.querySelector('svg');
  const path = el.querySelector('.shape-line');
  const ptsG = el.querySelector('.pts');
  const row = el.querySelector('.pts-row');
  const preset = el.querySelector('select[aria-label="Curve preset"]');
  const count = el.querySelector('[data-t=count]');
  ed.live = el.querySelector('.live');

  function draw() {
    const f = monotone(ed.xs, ed.ys);
    let d = '';
    for (let i = 0; i <= 100; i++) d += `${i ? 'L' : 'M'}${px(i / 100).toFixed(1)},${py(f(i / 100)).toFixed(1)}`;
    path.setAttribute('d', d);
    ptsG.innerHTML = ed.xs.map((x, i) => {
      const fixed = i === 0 || i === ed.xs.length - 1;
      return `<circle class="pt${fixed ? ' fixed' : ''}" data-i="${i}" cx="${px(x)}" cy="${py(ed.ys[i])}" r="7"/>`;
    }).join('');
    row.style.setProperty('--n', ed.xs.length);
    count.value = String(Math.min(MAX_INNER, Math.max(1, ed.xs.length - 2)));
    row.innerHTML = ed.xs.map((x, i) => {
      const fixed = i === 0 || i === ed.xs.length - 1;
      return `<label style="display:flex;flex-direction:column;gap:2px"><span>${Math.round(x * 100)}%</span>
        <input type="number" min="0" max="100" step="0.5" data-i="${i}" value="${(ed.ys[i] * 100).toFixed(1).replace(/\.0$/, '')}" ${fixed ? 'disabled' : ''}></label>`;
    }).join('');
  }

  ed.set = (nx, ny) => { ed.xs.splice(0, ed.xs.length, ...nx); ed.ys.splice(0, ed.ys.length, ...ny); draw(); };
  ed.commit = async () => {
    const data = [];
    ed.xs.forEach((x, i) => data.push(i === 0 ? 0 : i === ed.xs.length - 1 ? 65535 : Math.round(x * 65535), Math.round(ed.ys[i] * 65535)));
    // x must strictly increase; nudge a duplicate apart
    for (let i = 2; i < data.length; i += 2) if (data[i] <= data[i - 2]) data[i] = data[i - 2] + 1;
    return save(setting, data);
  };

  // dragging: vertical only, between 0 and 100 %
  let drag = null;
  const toY = (ev) => {
    const r = svg.getBoundingClientRect();
    const sy = (ev.clientY - r.top) * (SZ + 2 * PAD) / r.height;
    return Math.min(1, Math.max(0, 1 - (sy - PAD) / SZ));
  };
  svg.addEventListener('pointerdown', (ev) => {
    const t = ev.target.closest('.pt');
    if (!t || t.classList.contains('fixed')) return;
    drag = Number(t.dataset.i);
    svg.setPointerCapture(ev.pointerId);
    t.classList.add('drag');
  });
  svg.addEventListener('pointermove', (ev) => {
    if (drag === null) return;
    ed.ys[drag] = toY(ev);
    preset.value = 'Custom';
    draw();
    ptsG.querySelector(`[data-i="${drag}"]`)?.classList.add('drag');
  });
  const end = async () => {
    if (drag === null) return;
    drag = null;
    await ed.commit();
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  row.addEventListener('change', async (ev) => {
    const i = Number(ev.target.dataset.i);
    ed.ys[i] = Math.min(1, Math.max(0, Number(ev.target.value) / 100));
    preset.value = 'Custom';
    draw();
    await ed.commit();
  });
  // A different number of points: the curve as it is now, sampled at evenly spaced points
  count.addEventListener('change', async () => {
    const n = Number(count.value) + 2;
    const f = monotone(ed.xs, ed.ys);
    const nx = [...Array(n).keys()].map((i) => i / (n - 1));
    ed.set(nx, nx.map((x, i) => (i === 0 ? ed.ys[0] : i === n - 1 ? ed.ys[ed.ys.length - 1] : f(x))));
    await ed.commit();
  });
  el.querySelector('[data-t=restore]').addEventListener('click', async () => {
    const d = await restore(setting);
    if (!d) return;
    const xs = [];
    const ys = [];
    for (let i = 0; i + 1 < d.length; i += 2) { xs.push(d[i] / 65535); ys.push(d[i + 1] / 65535); }
    preset.value = 'Custom';
    ed.set(xs, ys);
  });
  preset.addEventListener('change', async () => {
    const f = PRESETS[preset.value];
    if (!f) return;
    ed.set(ed.xs.slice(), ed.xs.map((x, i) => (i === 0 ? 0 : i === ed.xs.length - 1 ? 1 : f(x))));
    await ed.commit();
  });
  draw();
  return ed;
}

// Live dot: how far the stick is pushed, against what the host gets
export function curveLive(s) {
  [[0, 1], [2, 3]].forEach(([ax, ay], i) => {
    const ed = editors[i];
    if (!ed) return;
    const rin = Math.min(1, Math.hypot(s.stick[ax], s.stick[ay]) / 32767);
    const out = s.stick_out ?? s.stick;
    const rout = Math.min(1, Math.hypot(out[ax], out[ay]) / 32767);
    ed.live.setAttribute('cx', px(rin).toFixed(1));
    ed.live.setAttribute('cy', py(rout).toFixed(1));
  });
}
