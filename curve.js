// Response curve editor: one per stick. Drag any point anywhere (the two ends move up and down
// only), double-click the plot to add a point, and give each point a smoothness from 1 (a sharp
// corner) to 10 (fully smooth). The curve never folds back.
//
// Values travel as 0..65535 pairs (x0, y0, x1, y1 ...); a point's smoothness rides in the low
// bits of its x, and curves saved before smoothness read exactly as they did.

const SZ = 300;        // plot size in svg units
const PAD = 30;
const MAX_POINTS = 13; // the firmware's limit, ends included
const MIN_GAP = 1 / 64; // closest two points may sit, in input travel
const SMOOTH = 10;     // default smoothness
const PRESETS = {
  Linear: (x) => x,
  Precise: (x) => x ** 1.6,      // finer near centre
  Fast: (x) => x ** 0.7,         // quicker start
  'S-curve': (x) => (x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) ** 2),
};

// The curve through (xs, ys), each point's smoothness ws (1..10, default 10): returns f(x) for
// x in 0..1. A smooth curve through the points that never folds back; lower smoothness makes a
// sharper corner at that point.
export function curveFn(xs, ys, ws = []) {
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
  const s = xs.map((_, i) => ((ws[i] ?? SMOOTH) - 1) / 9);
  return (x) => {
    let k = 0;
    while (k < n - 2 && x > xs[k + 1]) k++;
    const hgt = xs[k + 1] - xs[k];
    const u = Math.min(1, Math.max(0, (x - xs[k]) / hgt));
    const u2 = u * u;
    const u3 = u2 * u;
    const m0 = d[k] + s[k] * (m[k] - d[k]);
    const m1 = d[k] + s[k + 1] * (m[k + 1] - d[k]);
    const v = (2 * u3 - 3 * u2 + 1) * ys[k] + (u3 - 2 * u2 + u) * hgt * m0
      + (-2 * u3 + 3 * u2) * ys[k + 1] + (u3 - u2) * hgt * m1;
    return Math.min(1, Math.max(0, v));
  };
}

// Kept for anything still calling the old name: every point fully smooth
export const monotone = (xs, ys) => curveFn(xs, ys);

// Wire format <-> points
export function decodeCurve(data) {
  const xs = [];
  const ys = [];
  const ws = [];
  for (let i = 0; i + 1 < data.length; i += 2) {
    const w = data[i] & 0xF;
    const has = w >= 1 && w <= 10;
    xs.push((has ? data[i] & 0xFFF0 : data[i]) / 65535);
    ys.push(data[i + 1] / 65535);
    ws.push(has ? w : SMOOTH);
  }
  return { xs, ys, ws };
}

export function encodeCurve(xs, ys, ws) {
  const n = xs.length;
  // inner positions on the 16-step grid: x = pos * 16 / 65535, pos 1..4094
  const pos = xs.map((x, i) => (i === 0 ? 0 : i === n - 1 ? 4096 : Math.min(4094, Math.max(1, Math.round(x * 65535 / 16)))));
  // positions must strictly increase on the 12-bit grid
  for (let i = 1; i < n - 1; i++) if (pos[i] <= pos[i - 1]) pos[i] = pos[i - 1] + 1;
  for (let i = n - 2; i > 0; i--) if (pos[i] >= pos[i + 1]) pos[i] = pos[i + 1] - 1;
  const data = [];
  for (let i = 0; i < n; i++) {
    const x = i === 0 ? 0 : i === n - 1 ? 65535 : (pos[i] << 4) | Math.min(10, Math.max(1, Math.round(ws[i] ?? SMOOTH)));
    data.push(x, Math.round(Math.min(1, Math.max(0, ys[i])) * 65535));
  }
  return data;
}

const px = (x) => PAD + x * SZ;
const py = (y) => PAD + (1 - y) * SZ;
const pct = (v) => (v * 100).toFixed(1).replace(/\.0$/, '');

let editors = [];

// infos: [left setting, right setting] (SETTING_INFO fields plus .data from GET_SETTING)
// save(setting, data[]) -> Promise<status string>
export function initCurves(host, infos, save, restore) {
  host.innerHTML = '<div class="editors"></div><div class="row"><button data-act="copy">Copy left to right</button>'
    + '<button data-act="copy-back">Copy right to left</button></div>';
  const box = host.querySelector('.editors');
  editors = infos.map((s, i) => makeEditor(box, s, i ? 'Right stick' : 'Left stick', save, restore));
  const copy = async (from, to) => {
    if (editors.length < 2) return;
    const f = editors[from];
    editors[to].set(f.xs.slice(), f.ys.slice(), f.ws.slice());
    await editors[to].commit();
  };
  host.querySelector('[data-act=copy]').addEventListener('click', () => copy(0, 1));
  host.querySelector('[data-act=copy-back]').addEventListener('click', () => copy(1, 0));
}

function makeEditor(box, setting, title, save, restore) {
  const el = document.createElement('div');
  el.className = 'editor';
  const ed = { ...decodeCurve(setting.data), setting, sel: -1 };

  el.innerHTML = `<div class="row" style="margin-top:0;justify-content:space-between">
      <h3 style="margin:0">${title}</h3>
      <select aria-label="Curve preset">${['Custom', ...Object.keys(PRESETS)].map((p) => `<option>${p}</option>`).join('')}</select>
    </div>
    <div class="tools">
      <label>Points <select data-t="count" aria-label="Adjustable points">${[...Array(MAX_POINTS - 2).keys()]
        .map((i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select></label>
      <label>All smoothness <select data-t="all" aria-label="Smoothness for every point"><option value="">set...</option>${[...Array(10).keys()]
        .map((i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select></label>
      <button data-t="restore">Restore default</button>
    </div>
    <svg viewBox="0 0 ${SZ + 2 * PAD} ${SZ + 2 * PAD}">
      <defs><linearGradient id="hotgrad-e" x1="0" x2="1"><stop offset="0" stop-color="#ff8a1f"/><stop offset="1" stop-color="#e82035"/></linearGradient></defs>
      ${[...Array(9).keys()].map((k) => `<line class="grid-line" x1="${px(k / 8)}" y1="${py(0)}" x2="${px(k / 8)}" y2="${py(1)}"/>
        <line class="grid-line" x1="${px(0)}" y1="${py(k / 8)}" x2="${px(1)}" y2="${py(k / 8)}"/>`).join('')}
      <rect class="frame hit" x="${px(0)}" y="${py(1)}" width="${SZ}" height="${SZ}"/>
      <line class="ref" x1="${px(0)}" y1="${py(0)}" x2="${px(1)}" y2="${py(1)}"/>
      <path class="shape-line" fill="none" style="fill:none"/>
      <g class="pts"></g>
      <circle class="live" r="5" cx="-20" cy="-20"/>
      <text class="lbl" x="${px(0)}" y="${py(0) + 18}">0</text><text class="lbl" x="${px(1) - 22}" y="${py(0) + 18}">100 %</text>
      <text class="lbl" x="${px(0) - 26}" y="${py(1) + 4}">100</text>
    </svg>
    <div class="point-panel"></div>
    <p class="muted small" style="margin:6px 0 0">Input along the bottom, output up the side. Drag any point; the ends
      move up and down only. Double-click to add a point. Click a point to type its position or set its smoothness:
      1 is a sharp corner, 10 fully smooth.</p>`;
  box.appendChild(el);
  const svg = el.querySelector('svg');
  const path = el.querySelector('.shape-line');
  const ptsG = el.querySelector('.pts');
  const panel = el.querySelector('.point-panel');
  const preset = el.querySelector('select[aria-label="Curve preset"]');
  const count = el.querySelector('[data-t=count]');
  const all = el.querySelector('[data-t=all]');
  ed.live = el.querySelector('.live');
  const isEnd = (i) => i === 0 || i === ed.xs.length - 1;

  function drawCurve() {
    const f = curveFn(ed.xs, ed.ys, ed.ws);
    let d = '';
    for (let i = 0; i <= 300; i++) d += `${i ? 'L' : 'M'}${px(i / 300).toFixed(1)},${py(f(i / 300)).toFixed(1)}`;
    path.setAttribute('d', d);
    ptsG.innerHTML = ed.xs.map((x, i) => {
      const cls = `pt${isEnd(i) ? ' end' : ''}${i === ed.sel ? ' sel' : ''}`;
      // a sharp point is drawn square, so the corners are visible at a glance
      if (!isEnd(i) && ed.ws[i] <= 3) {
        return `<rect class="${cls}" data-i="${i}" x="${px(x) - 6}" y="${py(ed.ys[i]) - 6}" width="12" height="12"/>`;
      }
      return `<circle class="${cls}" data-i="${i}" cx="${px(x)}" cy="${py(ed.ys[i])}" r="7"/>`;
    }).join('');
    count.value = String(Math.min(MAX_POINTS - 2, Math.max(1, ed.xs.length - 2)));
  }

  function drawPanel() {
    const i = ed.sel;
    if (i < 0 || i >= ed.xs.length) {
      panel.innerHTML = '<p class="muted small" style="margin:6px 0 0">No point selected.</p>';
      return;
    }
    const end = isEnd(i);
    panel.innerHTML = `<div class="tools">
        <b style="font-size:12px">Point ${i + 1}${end ? (i === 0 ? ' (start)' : ' (end)') : ''}</b>
        <label>In % <input type="number" data-f="x" min="0" max="100" step="0.5" value="${pct(ed.xs[i])}" ${end ? 'disabled' : ''} style="width:64px"></label>
        <label>Out % <input type="number" data-f="y" min="0" max="100" step="0.5" value="${pct(ed.ys[i])}" style="width:64px"></label>
        ${end ? '' : `<label>Smoothness <input type="range" data-f="w" min="1" max="10" step="1" value="${ed.ws[i]}" style="width:110px">
          <b data-f="wv" style="min-width:16px">${ed.ws[i]}</b></label>
        <button data-f="remove">Remove point</button>`}
      </div>`;
  }

  function draw() { drawCurve(); drawPanel(); }

  ed.set = (nx, ny, nw) => {
    ed.xs.splice(0, ed.xs.length, ...nx);
    ed.ys.splice(0, ed.ys.length, ...ny);
    ed.ws.splice(0, ed.ws.length, ...(nw ?? nx.map(() => SMOOTH)));
    if (ed.sel >= ed.xs.length) ed.sel = -1;
    draw();
  };
  ed.commit = () => save(setting, encodeCurve(ed.xs, ed.ys, ed.ws));

  // where the pointer is, in curve units
  const at = (ev) => {
    const r = svg.getBoundingClientRect();
    const sx = (ev.clientX - r.left) * (SZ + 2 * PAD) / r.width;
    const sy = (ev.clientY - r.top) * (SZ + 2 * PAD) / r.height;
    return { x: Math.min(1, Math.max(0, (sx - PAD) / SZ)), y: Math.min(1, Math.max(0, 1 - (sy - PAD) / SZ)) };
  };
  // an inner point's x, kept between its neighbours
  const clampX = (i, x) => Math.min(ed.xs[i + 1] - MIN_GAP, Math.max(ed.xs[i - 1] + MIN_GAP, x));

  let drag = null;
  let moved = false;
  svg.addEventListener('pointerdown', (ev) => {
    const t = ev.target.closest('.pt');
    if (!t) return;
    drag = Number(t.dataset.i);
    moved = false;
    ed.sel = drag;
    svg.setPointerCapture(ev.pointerId);
    draw();
  });
  svg.addEventListener('pointermove', (ev) => {
    if (drag === null) return;
    const p = at(ev);
    if (!isEnd(drag)) ed.xs[drag] = clampX(drag, p.x);
    ed.ys[drag] = p.y;
    moved = true;
    preset.value = 'Custom';
    draw();
  });
  const end = async () => {
    if (drag === null) return;
    drag = null;
    if (moved) await ed.commit();
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  // double-click: a new point there, on the curve's current line, smoothness of its neighbours'
  svg.addEventListener('dblclick', async (ev) => {
    if (ev.target.closest('.pt') || ed.xs.length >= MAX_POINTS) return;
    const { x } = at(ev);
    let k = 1;
    while (k < ed.xs.length - 1 && ed.xs[k] < x) k++;
    if (x - ed.xs[k - 1] < MIN_GAP || ed.xs[k] - x < MIN_GAP) return;
    const y = curveFn(ed.xs, ed.ys, ed.ws)(x);
    ed.xs.splice(k, 0, x);
    ed.ys.splice(k, 0, y);
    ed.ws.splice(k, 0, SMOOTH);
    ed.sel = k;
    preset.value = 'Custom';
    draw();
    await ed.commit();
  });

  panel.addEventListener('input', (ev) => {
    if (ev.target.dataset.f !== 'w') return;
    ed.ws[ed.sel] = Number(ev.target.value);
    panel.querySelector('[data-f=wv]').textContent = ev.target.value;
    drawCurve();
  });
  panel.addEventListener('change', async (ev) => {
    const i = ed.sel;
    const f = ev.target.dataset.f;
    if (i < 0 || !f) return;
    if (f === 'x' && !isEnd(i)) ed.xs[i] = clampX(i, Number(ev.target.value) / 100);
    if (f === 'y') ed.ys[i] = Math.min(1, Math.max(0, Number(ev.target.value) / 100));
    if (f === 'w') ed.ws[i] = Number(ev.target.value);
    preset.value = 'Custom';
    draw();
    await ed.commit();
  });
  panel.addEventListener('click', async (ev) => {
    if (ev.target.dataset.f !== 'remove' || isEnd(ed.sel)) return;
    ed.xs.splice(ed.sel, 1);
    ed.ys.splice(ed.sel, 1);
    ed.ws.splice(ed.sel, 1);
    ed.sel = -1;
    draw();
    await ed.commit();
  });

  all.addEventListener('change', async () => {
    if (!all.value) return;
    const w = Number(all.value);
    all.value = '';
    ed.ws.forEach((_, i) => { ed.ws[i] = w; });
    draw();
    await ed.commit();
  });
  // A different number of points: the curve as it is now, sampled at evenly spaced points
  count.addEventListener('change', async () => {
    const n = Number(count.value) + 2;
    const f = curveFn(ed.xs, ed.ys, ed.ws);
    const nx = [...Array(n).keys()].map((i) => i / (n - 1));
    ed.set(nx, nx.map((x, i) => (i === 0 ? ed.ys[0] : i === n - 1 ? ed.ys[ed.ys.length - 1] : f(x))));
    await ed.commit();
  });
  el.querySelector('[data-t=restore]').addEventListener('click', async () => {
    const d = await restore(setting);
    if (!d) return;
    const c = decodeCurve(d);
    preset.value = 'Custom';
    ed.sel = -1;
    ed.set(c.xs, c.ys, c.ws);
  });
  preset.addEventListener('change', async () => {
    const f = PRESETS[preset.value];
    if (!f) return;
    ed.set(ed.xs.slice(), ed.xs.map((x, i) => (i === 0 ? 0 : i === ed.xs.length - 1 ? 1 : f(x))), ed.ws.slice());
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
