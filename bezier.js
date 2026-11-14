// Bezier curve editor: a curve from (0, 0) to (1, 1) bent by two handles, P1 and P2. Each handle
// is two settings (x and y, 0..100 %, as the controller shows them), so one editor stands in
// for four settings. Drag a handle, or type its numbers.

const SZ = 180;
const PAD = 14;
const px = (x) => PAD + x * SZ;
const py = (y) => PAD + (1 - y) * SZ;

function point(t, p1, p2) {
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

// quad: the four settings [x1, y1, x2, y2] (SETTING_INFO fields with .value)
// set(setting, value) -> Promise: saves one
export function bezierEditor(title, quad, set) {
  const el = document.createElement('div');
  el.className = 'bez';
  const v = () => quad.map((s) => s.value / 1000);
  el.innerHTML = `<div class="bez-title">${title}</div>
    <svg viewBox="0 0 ${SZ + 2 * PAD} ${SZ + 2 * PAD}" aria-label="${title}">
      <rect class="frame" x="${px(0)}" y="${py(1)}" width="${SZ}" height="${SZ}"/>
      <line class="ref" x1="${px(0)}" y1="${py(0)}" x2="${px(1)}" y2="${py(1)}"/>
      <line class="arm a1"/><line class="arm a2"/>
      <path class="bez-line" fill="none"/>
      <circle class="handle" data-h="0" r="7"/><circle class="handle" data-h="1" r="7"/>
    </svg>
    <div class="bez-nums">${['P1 x', 'P1 y', 'P2 x', 'P2 y'].map((n, i) => `<label>${n}
      <input type="number" min="0" max="100" step="0.1" data-i="${i}"></label>`).join('')}</div>
    <div class="bez-row"><button data-act="lin">Straight</button><button data-act="def">Default</button></div>`;
  const svg = el.querySelector('svg');
  const path = el.querySelector('.bez-line');
  const hs = el.querySelectorAll('.handle');
  const arms = [el.querySelector('.a1'), el.querySelector('.a2')];
  const nums = el.querySelectorAll('input');

  function draw() {
    const [x1, y1, x2, y2] = v();
    let d = '';
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      d += `${i ? 'L' : 'M'}${px(point(t, x1, x2)).toFixed(1)},${py(point(t, y1, y2)).toFixed(1)}`;
    }
    path.setAttribute('d', d);
    [[x1, y1, 0, 0], [x2, y2, 1, 1]].forEach(([hx, hy, ax, ay], k) => {
      hs[k].setAttribute('cx', px(hx));
      hs[k].setAttribute('cy', py(hy));
      arms[k].setAttribute('x1', px(ax));
      arms[k].setAttribute('y1', py(ay));
      arms[k].setAttribute('x2', px(hx));
      arms[k].setAttribute('y2', py(hy));
    });
    nums.forEach((n, i) => { if (document.activeElement !== n) n.value = (quad[i].value / 10).toFixed(1).replace(/\.0$/, ''); });
  }

  const save = async (values) => {
    for (let i = 0; i < 4; i++) {
      const want = Math.round(Math.min(1, Math.max(0, values[i])) * 1000);
      if (want !== quad[i].value) await set(quad[i], want);
    }
    draw();
  };

  let drag = null;
  const at = (ev) => {
    const r = svg.getBoundingClientRect();
    const sx = (ev.clientX - r.left) * (SZ + 2 * PAD) / r.width;
    const sy = (ev.clientY - r.top) * (SZ + 2 * PAD) / r.height;
    return [Math.min(1, Math.max(0, (sx - PAD) / SZ)), Math.min(1, Math.max(0, 1 - (sy - PAD) / SZ))];
  };
  svg.addEventListener('pointerdown', (ev) => {
    const h = ev.target.closest('.handle');
    if (!h) return;
    drag = { k: Number(h.dataset.h), live: v() };
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const [x, y] = at(ev);
    drag.live[drag.k * 2] = x;
    drag.live[drag.k * 2 + 1] = y;
    // draw the drag live without saving yet
    const keep = quad.map((s) => s.value);
    quad.forEach((s, i) => { s.value = Math.round(drag.live[i] * 1000); });
    draw();
    quad.forEach((s, i) => { s.value = keep[i]; });
  });
  const end = async () => {
    if (!drag) return;
    const live = drag.live;
    drag = null;
    await save(live);
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  nums.forEach((n) => n.addEventListener('change', () => {
    const vals = v();
    vals[Number(n.dataset.i)] = Number(n.value) / 100;
    save(vals);
  }));
  el.querySelector('[data-act=lin]').addEventListener('click', () => save([0, 0, 1, 1]));
  el.querySelector('[data-act=def]').addEventListener('click', () => save(quad.map((s) => s.default_value / 1000)));
  draw();
  return el;
}
