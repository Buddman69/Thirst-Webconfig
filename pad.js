// Live controller drawing: buttons, triggers and sticks light up from the controller's stream.
// Our own simple drawing. Button names come from the contract (ENUMS.button), so a button
// missing from the drawing still shows in the chip row below.

const W = 640;
const H = 400;

// [button name, shape, x, y, size or [w, h], label]
const KEYS = [
  ['L2', 'trig', 150, 26, [96, 30], 'L2'],
  ['R2', 'trig', 490, 26, [96, 30], 'R2'],
  ['L1', 'rect', 150, 70, [104, 18], 'L1'],
  ['R1', 'rect', 490, 70, [104, 18], 'R1'],
  ['DPAD_UP', 'rect', 150, 140, [24, 30], ''],
  ['DPAD_DOWN', 'rect', 150, 200, [24, 30], ''],
  ['DPAD_LEFT', 'rect', 120, 170, [30, 24], ''],
  ['DPAD_RIGHT', 'rect', 180, 170, [30, 24], ''],
  ['TRIANGLE', 'circ', 490, 132, 17, 'sym:tri'],
  ['CROSS', 'circ', 490, 208, 17, 'sym:cross'],
  ['SQUARE', 'circ', 452, 170, 17, 'sym:square'],
  ['CIRCLE', 'circ', 528, 170, 17, 'sym:circle'],
  ['CREATE', 'rect', 222, 118, [14, 26], ''],
  ['OPTIONS', 'rect', 418, 118, [14, 26], ''],
  ['TOUCHPAD', 'rect', 320, 140, [150, 78], 'Touchpad'],
  ['PS', 'circ', 320, 232, 13, 'PS'],
  ['MUTE', 'rect', 320, 260, [26, 8], ''],
  ['FN', 'rect', 320, 284, [34, 14], 'FN'],
  ['BB1', 'rect', 244, 352, [40, 16], 'B1'],
  ['BB2', 'rect', 290, 352, [40, 16], 'B2'],
  ['BB3', 'rect', 350, 352, [40, 16], 'B3'],
  ['BB4', 'rect', 396, 352, [40, 16], 'B4'],
];
const STICK_R = 34;        // well radius
const STICKS = [{ x: 236, y: 250, press: 'L3', ax: 0, ay: 1 }, { x: 404, y: 250, press: 'R3', ax: 2, ay: 3 }];

const BODY = 'M120 92 C 160 76, 480 76, 520 92 C 580 108, 612 170, 622 238 C 634 312, 612 352, 572 356 '
  + 'C 540 358, 516 330, 488 300 C 470 282, 450 276, 420 276 L 220 276 C 190 276, 170 282, 152 300 '
  + 'C 124 330, 100 358, 68 356 C 28 352, 6 312, 18 238 C 28 170, 60 108, 120 92 Z';

let els = null;

// Face-button symbols drawn as shapes (text glyphs vary by font); other labels as text
function symbol(label, x, y) {
  if (!label) return '';
  const st = 'class="sym" fill="none" stroke-width="2"';
  switch (label) {
    case 'sym:tri': return `<path ${st} d="M${x} ${y - 7} L${x + 7} ${y + 5} L${x - 7} ${y + 5} Z"/>`;
    case 'sym:cross': return `<path ${st} d="M${x - 6} ${y - 6} L${x + 6} ${y + 6} M${x + 6} ${y - 6} L${x - 6} ${y + 6}"/>`;
    case 'sym:square': return `<rect ${st} x="${x - 6}" y="${y - 6}" width="12" height="12"/>`;
    case 'sym:circle': return `<circle ${st} cx="${x}" cy="${y}" r="7"/>`;
    default: return `<text class="lbl" x="${x}" y="${y}">${label}</text>`;
  }
}

export function buildPad(host, buttonNames) {
  const keySvg = KEYS.map(([name, shape, x, y, size, label], i) => {
    if (!buttonNames.includes(name)) return '';
    let s;
    if (shape === 'circ') s = `<circle class="key" data-k="${name}" cx="${x}" cy="${y}" r="${size}"/>`;
    else if (shape === 'trig') {
      const [w, h] = size;
      s = `<rect class="key" data-k="${name}" x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="8"/>`
        + `<rect class="trig-fill" data-t="${name}" x="${x - w / 2}" y="${y - h / 2}" width="0" height="${h}" rx="8"/>`;
    } else {
      const [w, h] = size;
      s = `<rect class="key" data-k="${name}" x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="4"/>`;
    }
    return s + symbol(label, x, y) + (i === -1 ? '' : '');
  }).join('');
  const sticks = STICKS.map((s, i) => `
    <circle class="well" cx="${s.x}" cy="${s.y}" r="${STICK_R}"/>
    <circle class="cap" data-cap="${i}" data-k="${s.press}" cx="${s.x}" cy="${s.y}" r="18"/>
    <circle class="dot" data-dot="${i}" cx="${s.x}" cy="${s.y}" r="5"/>`).join('');
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Controller, live">
    <defs>
      <linearGradient id="hotgrad" x1="0" x2="1"><stop offset="0" stop-color="#ff8a1f"/><stop offset="1" stop-color="#e82035"/></linearGradient>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <path class="body" d="${BODY}"/>
    ${keySvg}${sticks}
  </svg>`;
  els = {
    keys: [...host.querySelectorAll('[data-k]')],
    trig: Object.fromEntries([...host.querySelectorAll('[data-t]')].map((e) => [e.dataset.t, e])),
    dots: [...host.querySelectorAll('[data-dot]')],
  };
}

// s: a decoded stream sample. stick values are what the host sees (stick_out when there is one).
export function drawPad(s, buttonNames) {
  if (!els) return;
  const stick = s.stick_out ?? s.stick;
  for (const e of els.keys) {
    const bit = buttonNames.indexOf(e.dataset.k);
    e.classList.toggle('on', bit >= 0 && ((s.buttons >>> bit) & 1) === 1);
  }
  const trig = { L2: s.trigger?.[0] ?? 0, R2: s.trigger?.[1] ?? 0 };
  for (const [name, el] of Object.entries(els.trig)) {
    const bit = buttonNames.indexOf(name);
    const pressed = bit >= 0 && ((s.buttons >>> bit) & 1) === 1;
    const frac = pressed ? 1 : Math.max(0, trig[name]) / 32767;
    el.setAttribute('width', (96 * frac).toFixed(1));
  }
  STICKS.forEach((st, i) => {
    const x = stick[st.ax] / 32767;
    const y = stick[st.ay] / 32767;
    els.dots[i].setAttribute('cx', (st.x + x * (STICK_R - 6)).toFixed(1));
    els.dots[i].setAttribute('cy', (st.y - y * (STICK_R - 6)).toFixed(1));
  });
}
