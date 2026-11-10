// Stick shape: the target reach in 16 directions (drag the points or pick a preset), with the
// measured reach from the rotation test and a live trace. 32768 = 100 %.

const N = 16;
const C = 165;          // centre of the svg
const S = 100;          // pixels per 100 %
const MIN = 0.5;
const MAX = 46341 / 32768;
const ang = (k) => (k * 2 * Math.PI) / N;     // direction k: 0 = right, anticlockwise

const PRESETS = {
  Circle: () => 1,
  'Rounded square': (t) => (Math.abs(Math.cos(t)) ** 4 + Math.abs(Math.sin(t)) ** 4) ** -0.25,
  Square: (t) => 1 / Math.max(Math.abs(Math.cos(t)), Math.abs(Math.sin(t))),
  Octagon: (t) => {
    const q = ((t % (Math.PI / 4)) + Math.PI / 4) % (Math.PI / 4);
    return Math.cos(Math.PI / 8) / Math.cos(q - Math.PI / 8);
  },
};

// Smooth closed curve through p[0..n-1] (one value per direction) at angle t (radians)
export function ring(p, t) {
  const n = p.length;
  const f = ((t / (2 * Math.PI)) % 1 + 1) % 1 * n;
  const i = Math.floor(f);
  const u = f - i;
  const p0 = p[(i - 1 + n) % n]; const p1 = p[i % n]; const p2 = p[(i + 1) % n]; const p3 = p[(i + 2) % n];
  return p1 + 0.5 * ((p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
}

const pt = (r, t) => [C + Math.cos(t) * r * S, C - Math.sin(t) * r * S];
const smoothPath = (p) => {
  let d = '';
  for (let i = 0; i <= 128; i++) {
    const t = (i / 128) * 2 * Math.PI;
    const [x, y] = pt(ring(p, t), t);
    d += `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return `${d}Z`;
};

// The target outline: a smooth closed curve through the 16 points (straight edges stay
// straight), clipped to 100 % per axis
const splinePath = (p) => {
  const P = p.map((r, k) => [Math.cos(ang(k)) * r, Math.sin(ang(k)) * r]);
  let d = '';
  for (let seg = 0; seg < N; seg++) {
    const [a, b, c, e] = [P[(seg - 1 + N) % N], P[seg], P[(seg + 1) % N], P[(seg + 2) % N]];
    for (let st = 0; st < 16; st++) {
      const u = st / 16;
      const f = (i) => 0.5 * (2 * b[i] + (c[i] - a[i]) * u + (2 * a[i] - 5 * b[i] + 4 * c[i] - e[i]) * u * u
        + (-a[i] + 3 * b[i] - 3 * c[i] + e[i]) * u * u * u);
      d += `${d ? 'L' : 'M'}${(C + f(0) * S).toFixed(1)},${(C - f(1) * S).toFixed(1)}`;
    }
  }
  return `${d}Z`;
};

let editors = [];
let api = null;
let polling = null;
let testing = false;

// infos: [left, right] SECTORS settings with .data; save(setting, data[]) -> status;
// call(cmd, args) -> reply; step(name) runs a CAL_STEP
export function initShapes(host, infos, save, call, step, restore) {
  api = { call, step };
  host.innerHTML = `<div class="row" style="margin-top:0">
      <button data-act="test" class="primary">Measure shape</button>
      <button data-act="done" disabled>Finish</button>
      <button data-act="cancel" disabled>Cancel</button>
      <button data-act="clear">Clear measurement</button>
      <span class="muted small" data-out="status"></span>
    </div>
    <div class="editors" style="margin-top:12px"></div>`;
  const box = host.querySelector('.editors');
  editors = infos.map((s, i) => makeEditor(box, s, i, save, restore));
  host.querySelector('[data-act=test]').addEventListener('click', () => { editors.forEach((e) => e.clearTrace()); step('SHAPE_TEST'); });
  host.querySelector('[data-act=done]').addEventListener('click', () => step('SHAPE_DONE'));
  host.querySelector('[data-act=cancel]').addEventListener('click', () => step('CANCEL'));
  host.querySelector('[data-act=clear]').addEventListener('click', async () => { await step('SHAPE_CLEAR'); await refresh(); });
  api.host = host;
  refresh();
}

function makeEditor(box, setting, stick, save, restore) {
  const el = document.createElement('div');
  el.className = 'editor';
  const ed = { stick, setting, tgt: setting.data.map((v) => v / 32768), trace: [], reach: null, covered: 0, saved: 0 };
  el.innerHTML = `<div class="row" style="margin-top:0;justify-content:space-between">
      <h3 style="margin:0">${stick ? 'Right stick' : 'Left stick'}</h3>
    </div>
    <div class="presets">${['Circle', 'Rounded square', 'Square', 'Octagon', 'Custom'].map((p) => `<button data-p="${p}">${p}</button>`).join('')}</div>
    <svg viewBox="0 0 ${2 * C} ${2 * C}">
      <defs><linearGradient id="hotgrad-e" x1="0" x2="1"><stop offset="0" stop-color="#ff8a1f"/><stop offset="1" stop-color="#e82035"/></linearGradient></defs>
      ${[...Array(N).keys()].map((k) => { const [x, y] = pt(MAX, ang(k)); return `<line class="grid-line" x1="${C}" y1="${C}" x2="${x}" y2="${y}"/>`; }).join('')}
      <circle class="ref" cx="${C}" cy="${C}" r="${S}"/>
      <path class="measured"/>
      <g class="mpts"></g>
      <clipPath id="axis-clip-${stick}"><rect x="${C - S}" y="${C - S}" width="${2 * S}" height="${2 * S}"/></clipPath>
      <path class="shape-line" clip-path="url(#axis-clip-${stick})"/>
      <path class="trace"/>
      <g class="pts"></g>
      <circle class="stick-dot" r="3" cx="${C}" cy="${C}"/>
    </svg>
    <div class="tools">
      <label><input type="checkbox" data-t="trail" checked> Trail</label>
      <button data-t="clear">Clear trail</button>
      <button data-t="reset">Restore default</button>
    </div>
    <div class="stats">
      <div>Measured<b data-s="cov">-</b></div>
      <div>Roundness, measured<b data-s="err">-</b></div>
      <div>Live radius<b data-s="live">-</b></div>
      <div>Directions changed<b data-s="adj">-</b></div>
    </div>
    <p class="muted small" style="margin:6px 0 0">Dashed: 100 %. Grey: how far the stick really reaches (green within ±5 % of round).
      Orange: the shape it is given. Drag a point in or out.</p>`;
  box.appendChild(el);
  const svg = el.querySelector('svg');
  const q = (s) => el.querySelector(s);

  ed.draw = () => {
    q('.shape-line').setAttribute('d', splinePath(ed.tgt));
    q('.pts').innerHTML = ed.tgt.map((r, k) => { const [x, y] = pt(r, ang(k)); return `<circle class="pt" data-k="${k}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6"/>`; }).join('');
    const adj = ed.tgt.filter((r) => Math.abs(r - 1) > 0.002).length;
    q('[data-s=adj]').textContent = `${adj}/${N}`;
    const act = ed.tgt.every((r) => Math.abs(r - 1) < 0.002) ? 'Circle'
      : Object.keys(PRESETS).find((p) => ed.tgt.every((r, k) => Math.abs(r - PRESETS[p](ang(k))) < 0.003)) ?? 'Custom';
    el.querySelectorAll('[data-p]').forEach((b) => b.classList.toggle('active', b.dataset.p === act));
  };
  ed.drawMeasured = () => {
    const r = ed.reach;
    if (!r || r.every((v) => v === 0)) {
      q('.measured').setAttribute('d', '');
      q('.mpts').innerHTML = '';
      q('[data-s=cov]').textContent = testing ? `0/${N}` : 'not yet';
      q('[data-s=err]').textContent = '-';
      return;
    }
    const v = r.map((x) => x / 32768);
    const have = v.map((x, k) => x > 0 && (testing ? (ed.covered >> k) & 1 : (ed.saved >> k) & 1));
    q('.measured').setAttribute('d', have.every(Boolean) ? smoothPath(v) : '');
    q('.mpts').innerHTML = v.map((x, k) => {
      if (!have[k]) return '';
      const [px, py] = pt(x, ang(k));
      return `<circle class="${Math.abs(x - 1) <= 0.05 ? 'ok-pt' : 'bad-pt'}" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.5"/>`;
    }).join('');
    const n = have.filter(Boolean).length;
    q('[data-s=cov]').textContent = `${n}/${N}${testing ? '' : ' saved'}`;
    const got = v.filter((x, k) => have[k]);
    q('[data-s=err]').textContent = got.length ? `±${(Math.max(...got.map((x) => Math.abs(x - 1))) * 100).toFixed(1)} %` : '-';
  };
  ed.clearTrace = () => { ed.trace = []; q('.trace').setAttribute('d', ''); };
  ed.live = (x, y) => {
    const [px, py] = [C + (x / 32767) * S, C - (y / 32767) * S];
    q('.stick-dot').setAttribute('cx', px.toFixed(1));
    q('.stick-dot').setAttribute('cy', py.toFixed(1));
    q('[data-s=live]').textContent = (Math.hypot(x, y) / 32767).toFixed(3);
    if (ed.trailOn && Math.hypot(x, y) > 0.3 * 32767) {
      ed.trace.push(`${px.toFixed(1)},${py.toFixed(1)}`);
      if (ed.trace.length > 900) ed.trace.shift();
      q('.trace').setAttribute('d', `M${ed.trace.join('L')}`);
    }
  };

  const commit = () => save(setting, ed.tgt.map((r) => Math.round(Math.min(MAX, Math.max(MIN, r)) * 32768)));
  ed.trailOn = true;
  q('[data-t=trail]').addEventListener('change', (e) => {
    ed.trailOn = e.target.checked;
    if (!ed.trailOn) ed.clearTrace();
  });
  q('[data-t=clear]').addEventListener('click', () => ed.clearTrace());
  // The controller's own default (a circle)
  q('[data-t=reset]').addEventListener('click', async () => {
    const d = await restore(setting);
    if (!d) return;
    ed.tgt = d.map((v) => v / 32768);
    ed.draw();
  });
  el.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', async () => {
    const f = PRESETS[b.dataset.p];
    if (!f) return;
    ed.tgt = [...Array(N).keys()].map((k) => Math.min(MAX, Math.max(MIN, f(ang(k)))));
    ed.draw();
    await commit();
  }));

  let drag = null;
  svg.addEventListener('pointerdown', (ev) => {
    const t = ev.target.closest('.pt');
    if (!t) return;
    drag = Number(t.dataset.k);
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener('pointermove', (ev) => {
    if (drag === null) return;
    const b = svg.getBoundingClientRect();
    const sx = (ev.clientX - b.left) * (2 * C) / b.width - C;
    const sy = C - (ev.clientY - b.top) * (2 * C) / b.height;
    // radial only: the distance along this point's own direction
    const along = sx * Math.cos(ang(drag)) + sy * Math.sin(ang(drag));
    ed.tgt[drag] = Math.min(MAX, Math.max(MIN, along / S));
    ed.draw();
  });
  const end = async () => { if (drag === null) return; drag = null; await commit(); };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  ed.draw();
  return ed;
}

async function refresh() {
  for (const ed of editors) {
    const r = (await api.call('GET_SHAPE', { stick: ed.stick })).fields;
    ed.reach = r.reach;
    ed.covered = r.covered;
    ed.saved = r.saved;
    ed.drawMeasured();
  }
  const status = api.host.querySelector('[data-out=status]');
  if (testing) {
    const n = editors.map((e) => bits(e.covered));
    status.textContent = `Roll both sticks slowly round their edge. Reached: left ${n[0]}/${N}, right ${n[1]}/${N}.`
      + (n.every((x) => x === N) ? ' Both done: press Finish.' : '');
  } else {
    status.textContent = '';
  }
}
const bits = (v) => v.toString(2).split('').filter((c) => c === '1').length;

// The controller's calibration state: the test runs while it is SHAPE
export function shapeCalState(st) {
  if (!api) return;
  const was = testing;
  testing = st === 'SHAPE';
  const h = api.host;
  h.querySelector('[data-act=test]').disabled = st !== 'IDLE';
  h.querySelector('[data-act=clear]').disabled = st !== 'IDLE';
  h.querySelector('[data-act=done]').disabled = !testing;
  h.querySelector('[data-act=cancel]').disabled = !testing;
  if (testing && !polling) polling = setInterval(() => refresh().catch(() => {}), 200);
  if (!testing && polling) { clearInterval(polling); polling = null; }
  if (was !== testing) refresh().catch(() => {});
}

export function shapeLive(s) {
  const out = s.stick_out ?? s.stick;
  // during the test show what is being measured (calibrated, before the shape); else the output
  const v = testing ? s.stick : out;
  editors.forEach((ed, i) => ed.live(v[2 * i], v[2 * i + 1]));
}
