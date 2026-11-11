// Thirst Config: a front end of the controller's config service over WebHID.
// It knows the protocol (contract.js, generated) and nothing else: the settings it shows are
// whatever the connected controller describes about itself.
import {
  ENUMS, HID_USAGE_PAGE, REPORT, decodeResponse, decodeStream, encodeRequest,
} from './contract.js';
import { buildPad, drawPad } from './pad.js';
import { initCurves, curveLive } from './curve.js';
import { initShapes, shapeCalState, shapeLive } from './shape.js';

const DEVICES = [
  { vendorId: 0x054C, productId: 0x0CE6, usagePage: HID_USAGE_PAGE },  // DualSense output mode
  { vendorId: 0x1209, productId: 0x0001, usagePage: HID_USAGE_PAGE },  // DInput output mode
  { vendorId: 0x1209, productId: 0x0002, usagePage: HID_USAGE_PAGE },  // XInput output mode
];
const REMAP_SELF = 254;
const REMAP_DEFAULT = 255;
const STREAM_HZ = 60;

const FRIENDLY = {
  CROSS: 'Cross', CIRCLE: 'Circle', SQUARE: 'Square', TRIANGLE: 'Triangle',
  L1: 'L1', R1: 'R1', L2: 'L2', R2: 'R2', CREATE: 'Create', OPTIONS: 'Options',
  L3: 'L3', R3: 'R3', PS: 'PS', TOUCHPAD: 'Touchpad', DPAD_UP: 'D-pad up',
  DPAD_DOWN: 'D-pad down', DPAD_LEFT: 'D-pad left', DPAD_RIGHT: 'D-pad right',
  BB1: 'Back 1', BB2: 'Back 2', BB3: 'Back 3', BB4: 'Back 4', FN: 'FN', MUTE: 'Mute',
};
const CAL_TEXT = {
  IDLE: 'Calibrated.', UNCALIBRATED: 'Not calibrated yet: the sticks use the full ADC range.',
  RANGE: 'Move both sticks round their full travel a few times, then let go and press Take centre.',
  CENTRE: 'Hands off the sticks...', FAILED: 'Rejected: too little travel, or a stick moved. Nothing changed.',
  RECENTRE: 'Recentring: hands off the sticks...',
  SHAPE: 'Measuring the stick shape: roll both sticks round their edge (see Stick shape).',
};

const MODE_NAME = { DUALSENSE: 'DualSense', DINPUT: 'DInput', XINPUT: 'XInput (Xbox 360)' };

// What each (i) beside a section or figure explains. General help only: settings explain
// themselves through the controller (SETTING_HELP).
const INFO = {
  controller: 'Which controller is connected and how it is performing right now. The figures update every '
    + 'second and are measured inside the controller.',
  polling: 'How many reports per second your PC is actually collecting from the controller. It should match '
    + 'the rate the controller runs at; less means the PC, a hub or the cable is not keeping up.',
  missed: 'The share of reports that reached the PC a frame later than intended, or had to be skipped because '
    + 'the previous one had not been collected yet. Lower is better; 0 to 2 % is normal.',
  delay: 'The average time from pressing a button to your PC having it, as the controller measures it: '
    + 'waiting for the next sample, building the report, and waiting for the PC to collect it. Your PC\'s own '
    + 'processing and the game come on top. The smaller figure is the worst of the last second.',
  live: 'What the controller is sending right now. The dots are the sticks; the bars are L2 and R2. A filled '
    + 'button is what the PC sees; an outlined one is physically pressed. So a back button mapped to Cross '
    + 'outlines Back 1 and fills Cross.',
  remap: 'Choose what each mappable button presses. "Itself" sends the button as it is. A change saves on the '
    + 'controller straight away; Default puts back the board\'s own mapping.',
  finetune: 'Adjust each stick by hand while watching the result, then save. Centre moves where the stick '
    + 'reads zero. Reach is how far the stick travels to read 100 % in each direction: less reach reaches full '
    + 'sooner. Values are shown at the stick resolution the PC gets (8 bits in DualSense mode); the '
    + 'controller always keeps them as 16-bit counts, so nothing is lost. You can also tune from the controller itself: L1 for centre mode, '
    + 'R1 for circularity, then the D-pad or face buttons. Changes are live but only kept when you press Save.',
  cal: 'Measures each stick\'s travel and centre. Press Start, roll both sticks around their full edge a few '
    + 'times, let go, then press Take centre and keep your hands off for a second. The table shows the result '
    + 'at the stick resolution the PC gets; the controller stores 16-bit counts whatever is shown. Rest noise is how much a stick wobbles when nobody touches it. Outside a '
    + 'calibration the centre button recentres: it keeps the travel and saves only where the sticks rest '
    + 'now (a double tap of FN does the same).',
  mode: 'What the PC sees. DualSense: a PlayStation 5 controller. DInput: a generic gamepad. XInput: an Xbox 360 '
    + 'controller, which Steam and nearly every PC game support directly. Switching restarts the controller; '
    + 'connect again afterwards. Holding FN while plugging in goes back to the default mode.',
  pipeline: 'Each stick axis from the sensor to the PC. Raw: the reading, in the resolution shown. Calibrated: '
    + 'after calibration, -100 to 100 %. Output: after shape, deadzone, curve, overshoot and clamp. Sent: the '
    + 'number the PC receives in the output mode in use (DualSense 0-255, XInput and DInput signed 16-bit at the '
    + 'chosen resolution).',
  shape: 'How far each stick reaches in each of 24 directions. Measure shape: roll both sticks slowly round their '
    + 'edge, a few turns each way, then Finish; the points are then set from your stick so full tilt goes just past '
    + '100 % in every direction (the headroom below). Turn Overshoot on to trim that to a perfect circle. Drag any '
    + 'point to fine-tune, or pick a shape. The shape belongs to the stick, so it is the same in every profile.',
  curve: 'How the stick responds between centre and edge, for each stick. The straight line is linear. Lower '
    + 'points in the middle give finer control near centre; higher points a faster start. The orange dot is '
    + 'where the stick is now. The deadzone settings below apply before the curve.',
  settings: 'Options this controller offers. Each one saves on the controller as you change it. Press (i) '
    + 'beside a setting to see what it does.',
  profile: 'The controller keeps 8 profiles, each with its own settings and button mapping. Calibration and the '
    + 'few settings marked "all profiles" belong to the controller and are the same in every profile. Every change '
    + 'you make here goes into the profile in use. On the controller, hold FN and press D-pad up, right, down or '
    + 'left for profiles 1 to 4, or Triangle, Circle, Cross or Square for 5 to 8; the light flashes the number.',
  file: 'Saves everything you have set (every setting, the button mapping and, if ticked, the stick '
    + 'calibration) to a file on your computer, and loads one back. Loading shows what would change first and '
    + 'changes nothing until you press Apply. Calibration belongs to one controller\'s sticks: leave it out of a '
    + 'file you give to someone else.',
  fault: 'If the controller ever crashes and restarts, the reason is kept here until it is unplugged. Useful '
    + 'for bug reports; Clear removes it.',
};

const $ = (id) => document.getElementById(id);
const name = (i) => FRIENDLY[ENUMS.button[i]] ?? ENUMS.button[i] ?? `#${i}`;

let dev = null;
let seq = 0;
const pending = new Map();

// ------------------------------------------------------------------ transport

function onReport(e) {
  if (e.reportId === REPORT.RESPONSE) {
    const r = decodeResponse(e.data);
    const p = pending.get(r.seq);
    if (p) {
      pending.delete(r.seq);
      clearTimeout(p.timer);
      p.resolve(r);
    }
  } else if (e.reportId === REPORT.STREAM) {
    drawLive(decodeStream(e.data));
  }
}

async function call(cmd, args = {}) {
  if (!dev) throw new Error('not connected');
  seq = (seq + 1) & 0xFF;
  const s = seq;
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(s); reject(new Error(`${cmd}: no reply`)); }, 1500);
    pending.set(s, { resolve, timer });
  });
  await dev.sendReport(REPORT.REQUEST, encodeRequest(cmd, s, args));
  return reply;
}

async function connect(d) {
  if (!d.opened) await d.open();
  dev = d;
  dev.addEventListener('inputreport', onReport);
  const hello = await call('HELLO');
  $('connect').classList.add('hidden');
  $('disconnect').classList.remove('hidden');
  $('connect-help').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('tabs').classList.remove('hidden');
  const f = hello.fields;
  const has = (feat) => (f.features >> ENUMS.feature.indexOf(feat)) & 1;
  feats = f.features;
  $('status').textContent = `Connected: ${f.board}, firmware ${f.firmware}`;
  $('st-board').textContent = f.board;
  $('st-fw').textContent = f.firmware;
  showMode(f.output_mode, has('MODE'));
  $('st-fw').title = `config protocol v${f.protocol}, frame v${f.frame_version}`;
  for (const id of ['st-poll', 'st-miss', 'st-delay']) $(id).closest('.stat').classList.toggle('hidden', !has('STATS'));
  $('sec-remap').classList.toggle('hidden', !has('REMAP'));
  $('sec-cal').classList.toggle('hidden', !has('CALIBRATION'));
  $('sec-settings').classList.toggle('hidden', !has('SETTINGS'));
  $('sec-fault').classList.toggle('hidden', !has('FAULT'));
  $('sec-file').classList.toggle('hidden', !has('SETTINGS'));
  $('sec-profiles').classList.toggle('hidden', !has('PROFILES'));
  $('st-profile-box').classList.toggle('hidden', !has('PROFILES'));
  closePlan();
  profiles = null;
  if (has('PROFILES')) await loadProfiles();
  $('sec-finetune').classList.toggle('hidden', !has('CALIBRATION'));
  boardName = f.board;
  buildChips();
  buildFinetune();
  renderHistory();
  if (has('REMAP')) await loadRemap();
  if (has('CALIBRATION')) await loadCal();
  if (has('SETTINGS')) await loadSettings();
  if (has('FAULT')) await loadFault();
  if (has('STREAM')) await call('STREAM', { rate_hz: STREAM_HZ });
  if (has('STATS')) {
    await call('GET_STATS');	// restart the controller's window so the first figure is a clean second
    statsTimer = setInterval(() => loadStats().catch(() => {}), 1000);
  }
  if (has('PROFILES')) profileTimer = setInterval(() => watchProfile().catch(() => {}), 1000);
}

async function disconnect() {
  clearInterval(statsTimer);
  statsTimer = null;
  clearInterval(profileTimer);
  profileTimer = null;
  if (dev) {
    try { await call('STREAM', { rate_hz: 0 }); } catch { /* already gone */ }
    dev.removeEventListener('inputreport', onReport);
    try { await dev.close(); } catch { /* ignore */ }
  }
  dev = null;
  cal = null;
  $('connect').classList.remove('hidden');
  $('disconnect').classList.add('hidden');
  $('app').classList.add('hidden');
  $('tabs').classList.add('hidden');
  $('connect-help').classList.remove('hidden');
  $('status').textContent = 'Not connected';
}

// ------------------------------------------------------------------ live input

function buildChips() {
  buildPad($('pad'), ENUMS.button);
  $('chips').innerHTML = ENUMS.button
    .map((b, i) => `<span class="chip" data-i="${i}">${escapeHtml(name(i))}</span>`).join('');
  buildAxisTable();
}

// The analog pipeline per axis: raw reading, after calibration, what the shaping stages send,
// and the value the PC gets in the output mode in use
const AXES = [['LX', 0, false], ['LY', 1, true], ['RX', 2, false], ['RY', 3, true]];

function buildAxisTable() {
  $('axis-table').innerHTML = `<tr><th>Input</th><th>Raw</th><th>Calibrated</th><th>Output</th><th>Sent</th></tr>`
    + AXES.map(([n]) => `<tr data-a="${n}"><td>${n}</td><td></td><td></td><td></td><td class="hot"></td></tr>`).join('')
    + ['L2', 'R2'].map((n) => `<tr data-t="${n}"><td>${n}</td><td>-</td><td></td><td></td><td class="hot"></td></tr>`).join('');
}

const pct = (v) => `${(v / 327.67).toFixed(1)} %`;
const quant = (v, bits) => {
  if (bits >= 16) return v;
  const m = 2 ** (bits - 1) - 1;
  return Math.round(Math.round(v * m / 32767) * 32767 / m);
};
// DualSense packs an axis to 0..255 (128 = centre), with Y flipped (down is larger)
const ds8 = (v) => Math.floor(((v + 32767) * 255 + 32767) / 65534);

function sentValue(v, flipY) {
  const mode = ENUMS.output_mode[Number($('st-mode-sel').dataset.current)];
  if (mode === 'DUALSENSE') return ds8(flipY ? -v : v);
  const q = quant(v, dispBits);
  return mode === 'DINPUT' && flipY ? -q : q;
}

function drawAxisTable(s) {
  const out = s.stick_out ?? s.stick;
  for (const [n, i, flipY] of AXES) {
    const tr = $('axis-table').querySelector(`[data-a="${n}"]`);
    if (!tr) continue;
    const c = tr.children;
    c[1].textContent = dv(s.stick_raw[i]);
    c[2].textContent = pct(s.stick[i]);
    c[3].textContent = pct(out[i]);
    c[4].textContent = sentValue(out[i], flipY);
  }
  ['L2', 'R2'].forEach((n, i) => {
    const tr = $('axis-table').querySelector(`[data-t="${n}"]`);
    const bit = ENUMS.button.indexOf(n);
    const pressed = bit >= 0 && ((s.buttons >>> bit) & 1) === 1;
    const v = pressed ? 32767 : Math.max(0, s.trigger[i]);
    tr.children[2].textContent = pct(v);
    tr.children[3].textContent = pct(v);
    tr.children[4].textContent = Math.round(v * 255 / 32767);
  });
}

function drawLive(s) {
  drawPad(s, ENUMS.button);
  drawAxisTable(s);
  for (const c of $('chips').children) {
    const bit = 1 << Number(c.dataset.i);
    c.classList.toggle('on', (s.buttons & bit) !== 0);
    c.classList.toggle('raw', (s.buttons_raw & bit) !== 0);
  }
  drawFinetune(s);
  padControl(s);
  curveLive(s);
  shapeLive(s);
  const st = ENUMS.cal_state[s.cal_state];
  if (st !== lastCalState) {
    lastCalState = st;
    showCalState(st);
    if (st === 'IDLE' || st === 'FAILED' || st === 'UNCALIBRATED') loadCal().catch(() => {});
  }
}

// ------------------------------------------------------------------ fold-away panels

// Every panel with a heading can be folded down to just its heading; remembered per panel
function buildFolds() {
  let folded = {};
  try { folded = JSON.parse(localStorage.getItem('thirst.folded') || '{}'); } catch { /* storage off */ }
  document.querySelectorAll('main section.panel[id]').forEach((sec) => {
    const h2 = sec.querySelector(':scope > h2');
    if (!h2 || h2.querySelector('.fold')) return;
    const b = document.createElement('button');
    b.className = 'fold';
    b.title = 'Fold away / open';
    const set = (f) => {
      sec.classList.toggle('folded', f);
      b.setAttribute('aria-expanded', String(!f));
      b.setAttribute('aria-label', `${f ? 'Open' : 'Fold away'} ${h2.textContent.trim()}`);
    };
    b.addEventListener('click', () => {
      const f = !sec.classList.contains('folded');
      set(f);
      folded[sec.id] = f;
      try { localStorage.setItem('thirst.folded', JSON.stringify(folded)); } catch { /* storage off */ }
    });
    h2.appendChild(b);
    set(!!folded[sec.id]);
  });
}

// ------------------------------------------------------------------ tabs

function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.dataset.tab !== name));
  try { localStorage.setItem('thirst.tab', name); } catch { /* storage off */ }
}

// ------------------------------------------------------------------ mapping

async function loadRemap(reply) {
  const r = reply ?? await call('GET_REMAP');
  const { active, defaults } = r.fields;
  const box = $('remap');
  box.innerHTML = '';
  const shown = active.map((a, i) => i).filter((i) => active[i] !== REMAP_SELF || defaults[i] !== REMAP_SELF);
  if (!shown.length) {
    box.innerHTML = '<p class="muted">This controller has no mappable buttons.</p>';
    return;
  }
  for (const i of shown) {
    const row = document.createElement('div');
    row.className = 'map-row';
    const opts = [`<option value="${REMAP_SELF}">Itself</option>`]
      .concat(ENUMS.button.map((b, t) => (t === i ? '' : `<option value="${t}">${escapeHtml(name(t))}</option>`)));
    const changed = active[i] !== defaults[i];
    row.innerHTML = `<div>${escapeHtml(name(i))} ${changed ? '<span class="changed">changed</span>' : ''}</div>
      <select aria-label="${escapeHtml(name(i))} presses">${opts.join('')}</select>
      <button ${changed ? '' : 'disabled'}>Default</button>`;
    const sel = row.querySelector('select');
    sel.value = String(active[i]);
    sel.addEventListener('change', () => setRemap(i, Number(sel.value)));
    row.querySelector('button').addEventListener('click', () => setRemap(i, REMAP_DEFAULT));
    box.appendChild(row);
  }
}

async function setRemap(source, target) {
  const r = await call('SET_REMAP', { source, target });
  note('remap-msg', r.status === 'OK' ? 'Saved on the controller.' : `Refused (${r.status}).`, r.status === 'OK');
  await loadRemap(r);
}

// ------------------------------------------------------------------ calibration

let lastCalState = null;

function showCalState(st) {
  $('cal-state').textContent = CAL_TEXT[st] ?? st;
  const busy = st === 'RANGE' || st === 'CENTRE' || st === 'RECENTRE' || st === 'SHAPE';
  shapeCalState(st);
  // One centre button: during a calibration it takes the centre; otherwise it recentres (keeps the
  // travel, saves where the sticks rest now), the same as a double tap of FN
  const centre = $('cal-centre');
  centre.textContent = st === 'RANGE' ? 'Take centre' : 'Recentre';
  centre.title = st === 'RANGE' ? 'Let go of both sticks, then press' : 'Save where the sticks rest now as their centre (or double-tap FN)';
  centre.disabled = !(st === 'RANGE' || st === 'IDLE');
  $('cal-start').disabled = busy;
  $('cal-cancel').disabled = !busy;
}

function renderCalTable() {
  const c = calFields;
  if (!c) return;
  const rms = (i) => (c.noise_rms_x16[i] / 16 * dmax() / 65535).toFixed(dispBits >= 12 ? 2 : 3);
  let html = `<tr><th>Axis</th><th>Min</th><th>Centre</th><th>Max</th><th>Rest noise p-p</th><th>RMS</th></tr>`;
  ENUMS.stick_axis.forEach((a, i) => {
    html += `<tr><td>${a}${c.invert[i] ? ' (inv)' : ''}</td><td>${dv(c.min[i])}</td><td>${dv(c.centre[i])}</td>
      <td>${dv(c.max[i])}</td><td>${dv(c.noise_pp[i])}</td><td>${rms(i)}</td></tr>`;
  });
  $('cal-table').innerHTML = html;
  $('cal-bits').textContent = `${dispBits}-bit counts`;
}

async function loadCal() {
  const r = await call('GET_CAL');
  const c = r.fields;
  calFields = c;
  renderCalTable();
  setCal(c);
  lastCalState = ENUMS.cal_state[c.state];
  showCalState(lastCalState);
  if (!c.saved) $('cal-state').textContent = CAL_TEXT.UNCALIBRATED;
}

async function calStep(step) {
  const r = await call('CAL_STEP', { step: ENUMS.cal_step.indexOf(step) });
  note('cal-msg', r.status === 'OK' ? '' : `Refused (${r.status}).`, r.status === 'OK');
}

// ------------------------------------------------------------------ fine-tune
// Manual stick adjustment: nudge each stick's centre and its reach in each direction, watch the
// result live, then save. Values are 16-bit counts (every board scales its ADC to 0-65535); "reach" is
// the travel from centre to 100%.

let cal = null;

// Display resolution: the controller keeps every stick count in 16 bits (0-65535) and so does
// this page; numbers are only shown at the resolution the PC gets (the Stick resolution
// setting, or 8 in DualSense mode), and fine-tune steps are in those units. Saving always
// sends the 16-bit values.
let dispBits = 16;
const dmax = () => 2 ** dispBits - 1;
const dv = (v) => Math.round(v * dmax() / 65535);
const step16 = (n) => Math.sign(n) * Math.max(1, Math.round(Math.abs(n) * 65535 / dmax()));
let calFields = null;

// Fine-tune step sizes, in displayed counts, for each resolution: one count of 16 bits is
// invisible, one count of 8 bits is a coarse move
function stepChoices(bits) {
  if (bits >= 15) return [1, 10, 50, 100, 250, 500];
  if (bits >= 13) return [1, 5, 10, 25, 50, 100];
  if (bits >= 11) return [1, 2, 5, 10, 25, 50];
  if (bits >= 9) return [1, 2, 5, 10, 20];
  return [1, 2, 5, 10];
}

// The step list for the current resolution; keeps the remembered step for it if there is one
function buildSteps() {
  const sel = $('ft-step');
  const choices = stepChoices(dispBits);
  let want = null;
  try { want = Number(localStorage.getItem(`thirst.ftStep.${dispBits}`)); } catch { /* storage off */ }
  if (!choices.includes(want)) want = choices[Math.min(2, choices.length - 1)];
  sel.innerHTML = choices.map((v) => `<option value="${v}" ${v === want ? 'selected' : ''}>${v}</option>`).join('');
  labelRowButtons();
}

const rowStep = (d) => (d === '+S' ? 1 : d === '-S' ? -1 : 0) * (Number($('ft-step').value) || 1) + (d === '+1' ? 1 : d === '-1' ? -1 : 0);

function labelRowButtons() {
  document.querySelectorAll('.ft-stick button[data-d]').forEach((b) => {
    const v = rowStep(b.dataset.d);
    b.textContent = `${v > 0 ? '+' : '−'}${Math.abs(v)}`;
    b.title = `${v > 0 ? '+' : '−'}${Math.abs(v)} ${dispBits}-bit count${Math.abs(v) === 1 ? '' : 's'}`;
  });
}

function setDispBits(bits) {
  const b = Math.max(1, Math.min(16, Number(bits) || 16));
  if (b === dispBits && $('ft-step').options.length) return;
  dispBits = b;
  buildSteps();
  renderCalTable();
  renderFinetune();
}

// What the PC gets: 8 bits in DualSense mode, else the Stick resolution setting
function updateDispBits() {
  const mode = ENUMS.output_mode[Number($('st-mode-sel').dataset.current)];
  setDispBits(mode === 'DUALSENSE' ? 8 : (outBitsSetting?.value ?? 16));
}
let outBitsSetting = null;
let boardName = '';
let ftView = 'normal';
const BINS = 48;
const trace = [new Array(BINS).fill(0), new Array(BINS).fill(0)];
const STICKS = [{ label: 'Left stick', x: 0, y: 1 }, { label: 'Right stick', x: 2, y: 3 }];
const ROWS = [['Centre X', 'cx'], ['Centre Y', 'cy'], ['Left reach', 'left'], ['Right reach', 'right'],
              ['Up reach', 'up'], ['Down reach', 'down']];
const FT_HINT = {
  normal: 'The dot is what the controller sends. Push the stick to each edge: it should just touch the ring.',
  zoom: 'Centre ×10: the ring is 10% deflection. Hands off, then nudge the centre until the dot sits in the middle.',
  circle: 'Roll each stick slowly round its edge a few times. A perfect stick traces the ring; the error is how far it strays. '
    + 'Hold a stick at an edge: the button pointing that way moves the dot out, the opposite one moves it in.',
};
const MIN_REACH = 1024;  // 16-bit counts
const HISTORY_KEY = 'thirst.calHistory';

/* Which raw end of which axis is each direction. Inside the firmware +X is right and +Y is up;
   invert says the raw reading runs the other way. */
function end(st, dir) {
  const s = STICKS[st];
  const inv = (a) => cal.invert[a] !== 0;
  switch (dir) {
    case 'left': return { a: s.x, which: inv(s.x) ? 'max' : 'min' };
    case 'right': return { a: s.x, which: inv(s.x) ? 'min' : 'max' };
    case 'up': return { a: s.y, which: inv(s.y) ? 'min' : 'max' };
    default: return { a: s.y, which: inv(s.y) ? 'max' : 'min' };
  }
}

// A value typed in the shown resolution: move that centre or reach to it (16-bit underneath)
function rowRaw(st, k) {
  const s = STICKS[st];
  if (k === 'cx') return cal.centre[s.x];
  if (k === 'cy') return cal.centre[s.y];
  const e = end(st, k);
  return Math.abs(cal[e.which][e.a] - cal.centre[e.a]);
}

async function setRow(st, k, shown) {
  const want = Number(shown);
  if (!cal || !Number.isFinite(want)) return;
  await nudge(st, k, Math.round(want * 65535 / dmax()) - rowRaw(st, k));
}

function rowValue(st, k) {
  const s = STICKS[st];
  if (k === 'cx') return dv(cal.centre[s.x]);
  if (k === 'cy') return dv(cal.centre[s.y]);
  const e = end(st, k);
  return dv(Math.abs(cal[e.which][e.a] - cal.centre[e.a]));
}

function buildFinetune() {
  document.querySelectorAll('.ft-stick').forEach((el) => {
    const st = Number(el.dataset.stick);
    // Values in pairs; each looks like a plain number and can be clicked and typed over
    const vals = ROWS.map(([label, k]) => `<label><span>${label}</span>
      <input class="v" data-k="${k}" type="number" min="0" step="1" aria-label="${STICKS[st].label} ${label}"></label>`).join('');
    el.innerHTML = `<h3>${STICKS[st].label}</h3>
      <div class="ft-top">
        <svg width="260" height="260" viewBox="-90 -90 180 180">
          <circle r="80" fill="none" stroke="var(--stick-ring)" stroke-width="2"/>
          <line x1="-80" y1="0" x2="80" y2="0" stroke="var(--stick-ring)"/>
          <line x1="0" y1="-80" x2="0" y2="80" stroke="var(--stick-ring)"/>
          <path class="trace" fill="none"/>
          <circle class="dot stick-dot" r="2.5"/>
        </svg>
        <div class="ft-side">
          <div class="ft-read"></div>
          <div class="ft-vals">${vals}</div>
        </div>
      </div>`;
    el.querySelectorAll('input[data-k]').forEach((inp) =>
      inp.addEventListener('change', guard(() => setRow(st, inp.dataset.k, inp.value))));
  });
  labelRowButtons();
  setView(ftView);
}

function setView(v) {
  ftView = v;
  document.querySelectorAll('.view-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('ft-hint').textContent = FT_HINT[v];
  $('ft-circle-reset').classList.toggle('hidden', v !== 'circle');
  if (v === 'circle') trace.forEach((t) => t.fill(0));
}

function renderFinetune() {
  if (!cal) return;
  document.querySelectorAll('.ft-stick').forEach((el) => {
    const st = Number(el.dataset.stick);
    el.querySelectorAll('.v[data-k]').forEach((v) => {
      if (document.activeElement !== v) v.value = rowValue(st, v.dataset.k);   // not while typing
    });
  });
  $('ft-bits').textContent = `${dispBits}-bit counts`;
  $('ft-unsaved').classList.toggle('hidden', !cal.unsaved);
  $('ft-save').disabled = !cal.unsaved;
  $('ft-revert').disabled = !cal.unsaved;
}

function setCal(fields) {
  cal = fields;
  calFields = fields;
  renderCalTable();
  renderFinetune();
}

async function nudge(st, k, d) {
  if (!cal) return;
  const min = [...cal.min];
  const centre = [...cal.centre];
  const max = [...cal.max];
  const s = STICKS[st];
  if (k === 'cx' || k === 'cy') {
    const a = k === 'cx' ? s.x : s.y;
    centre[a] = Math.min(max[a] - MIN_REACH, Math.max(min[a] + MIN_REACH, centre[a] + d));
  } else {
    const e = end(st, k);
    const arr = e.which === 'min' ? min : max;
    const reach = Math.max(MIN_REACH, Math.abs(arr[e.a] - centre[e.a]) + d);
    arr[e.a] = e.which === 'min' ? Math.max(0, centre[e.a] - reach) : Math.min(cal.adc_max, centre[e.a] + reach);
  }
  const r = await call('CAL_SET', { min, centre, max });
  if (r.status !== 'OK') note('ft-msg', `Refused (${r.status}).`, false);
  setCal(r.fields);
}

function drawFinetune(s) {
  if (!cal) return;
  document.querySelectorAll('.ft-stick').forEach((el) => {
    const st = Number(el.dataset.stick);
    const ax = STICKS[st].x;
    const ay = STICKS[st].y;
    const x = s.stick[ax] / 32767;
    const y = s.stick[ay] / 32767;
    const k = ftView === 'zoom' ? 10 : 1;
    const zx = Math.max(-1.1, Math.min(1.1, x * k));
    const zy = Math.max(-1.1, Math.min(1.1, y * k));
    const dot = el.querySelector('.dot');
    dot.setAttribute('cx', (zx * 80).toFixed(1));
    dot.setAttribute('cy', (-zy * 80).toFixed(1));

    let err = '';
    const path = el.querySelector('.trace');
    if (ftView === 'circle') {
      const r = Math.hypot(x, y);
      if (r > 0.2) {
        const b = Math.floor(((Math.atan2(y, x) + Math.PI) / (2 * Math.PI)) * BINS) % BINS;
        trace[st][b] = Math.max(trace[st][b], r);
      }
      const t = trace[st];
      let d = '';
      t.forEach((rr, i) => {
        if (!rr) return;
        const ang = (i + 0.5) / BINS * 2 * Math.PI - Math.PI;
        d += `${d ? 'L' : 'M'}${(Math.cos(ang) * rr * 80).toFixed(1)},${(-Math.sin(ang) * rr * 80).toFixed(1)}`;
      });
      path.setAttribute('d', d);
      const filled = t.filter((rr) => rr > 0.2);
      err = filled.length >= BINS / 2
        ? `${(Math.sqrt(filled.reduce((a, rr) => a + (rr - 1) ** 2, 0) / filled.length) * 100).toFixed(1)} %`
        : `roll the stick round (${filled.length}/${BINS})`;
    } else {
      path.setAttribute('d', '');
    }
    const acBits = (s.ac_state >> (2 * st)) & 3;
    const acText = acBits & 2 ? 'trimming' : acBits & 1 ? 'at rest' : 'off / moving';
    const trim = (i) => `${s.stick_trim[i] >= 0 ? '+' : ''}${dv(s.stick_trim[i])}`;
    el.querySelector('.ft-read').innerHTML =
      `<div><span>Raw</span><b>${dv(s.stick_raw[ax])}, ${dv(s.stick_raw[ay])}</b></div>`
      + `<div><span>Output</span><b>${(x * 100).toFixed(1)} %, ${(y * 100).toFixed(1)} %</b></div>`
      + `<div><span>Auto-centre</span><b>${acText}</b></div>`
      + `<div><span>Trim</span><b>${trim(ax)}, ${trim(ay)}</b></div>`
      + (ftView === 'circle' ? `<div class="wide"><span>Circularity error</span><b>${err}</b></div>` : '');
  });
}

// ---- driving fine-tune from the controller's own buttons (DualShock Tools layout)
// L1 centre mode, R1 circularity mode. The stick you push is the one being tuned.
// Centre mode (stick near centre): D-pad or face buttons move the output that way.
// Circularity mode (stick held at an edge): the D-pad or face button pointing the way the stick
// is held moves the dot out (more output), the opposite one moves it in, on every edge (held
// right: Right/Circle = out, Left/Square = in). Hold L2/R2 to set that reach so the stick reads
// 99% where it is held. Held buttons repeat after 400 ms, every 150 ms. Arrow keys = D-pad.

let activeStick = null;
let lastSample = null;
let padBusy = false;
const held = {};
const keys = new Set();
const KEYMAP = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

function padPressed(s) {
  const b = (n) => (s.buttons_raw >> ENUMS.button.indexOf(n)) & 1;
  return {
    left: b('DPAD_LEFT') || b('SQUARE') || keys.has('left'),
    right: b('DPAD_RIGHT') || b('CIRCLE') || keys.has('right'),
    up: b('DPAD_UP') || b('TRIANGLE') || keys.has('up'),
    down: b('DPAD_DOWN') || b('CROSS') || keys.has('down'),
    l1: b('L1'), r1: b('R1'), auto: b('L2') || b('R2'),
  };
}

function stickOut(s, st) {
  return { x: s.stick[STICKS[st].x] / 32767, y: s.stick[STICKS[st].y] / 32767 };
}

function quadrant(s, st) {
  const { x, y } = stickOut(s, st);
  if (Math.abs(x) >= 0.5 && Math.abs(y) < 0.2) return x < 0 ? 'left' : 'right';
  if (Math.abs(y) >= 0.5 && Math.abs(x) < 0.2) return y > 0 ? 'up' : 'down';
  return null;
}

function setActive(st) {
  activeStick = st;
  document.querySelectorAll('.ft-stick').forEach((el) =>
    el.classList.toggle('active', Number(el.dataset.stick) === st));
}

/* Move the centre so the output shifts in direction dir. Output follows raw - centre on a
   normal axis, and the opposite way on an inverted one. */
function centreMove(st, dir, step) {
  const s = STICKS[st];
  const inv = (a) => cal.invert[a] !== 0;
  if (dir === 'left') return nudge(st, 'cx', inv(s.x) ? -step : step);
  if (dir === 'right') return nudge(st, 'cx', inv(s.x) ? step : -step);
  if (dir === 'up') return nudge(st, 'cy', inv(s.y) ? step : -step);
  return nudge(st, 'cy', inv(s.y) ? -step : step);
}

async function reachTo99(st, q) {
  const e = end(st, q);
  const dist = Math.abs(lastSample.stick_raw[e.a] - cal.centre[e.a]);
  if (dist < MIN_REACH) return;
  const reach = Math.round(dist / 0.99);
  const current = Math.abs(cal[e.which][e.a] - cal.centre[e.a]);
  await nudge(st, q, reach - current);
}

let padMsg = '';

async function padAct(name, s) {
  if (name === 'l1') { setView('zoom'); return; }
  if (name === 'r1') { setView('circle'); return; }
  if (ftView !== 'zoom' && ftView !== 'circle') return;
  if (activeStick === null) { padMsg = 'Push a stick to choose it.'; return; }
  const step = step16(Number($('ft-step').value) || 1);
  if (ftView === 'zoom') {
    const { x, y } = stickOut(s, activeStick);
    if (Math.abs(x) >= 0.5 || Math.abs(y) >= 0.5) { padMsg = 'Let the stick go back to centre first.'; return; }
    if (name === 'auto') return;
    await centreMove(activeStick, name, step);
    return;
  }
  const q = quadrant(s, activeStick);
  if (!q) { padMsg = 'Hold the stick against one edge (left, right, up or down).'; return; }
  if (name === 'auto') { await reachTo99(activeStick, q); return; }
  const horizontal = q === 'left' || q === 'right';
  if (horizontal !== (name === 'left' || name === 'right')) return;
  // Relative to where the stick is held: pressing that way moves the dot that way (out, more
  // output); pressing back towards centre moves it in. Same feel on all four edges.
  const more = name === q;
  await nudge(activeStick, q, more ? -step : step);	// shorter reach = more output
}

function padControl(s) {
  lastSample = s;
  if (!cal) return;
  const l = stickOut(s, 0);
  const r = stickOut(s, 1);
  const pushedL = Math.hypot(l.x, l.y) > 0.2;
  const pushedR = Math.hypot(r.x, r.y) > 0.2;
  if (pushedL !== pushedR) setActive(pushedL ? 0 : 1);
  else if (pushedL && pushedR) setActive(null);

  const now = performance.now();
  const pressed = padPressed(s);
  for (const [name, on] of Object.entries(pressed)) {
    if (!on) { delete held[name]; continue; }
    const h = held[name];
    let fire = false;
    if (!h) { held[name] = { since: now, last: now }; fire = true; }
    else if (name !== 'l1' && name !== 'r1' && now - h.since >= 400 && now - h.last >= 150) { h.last = now; fire = true; }
    if (fire && !padBusy) {
      padMsg = '';
      padBusy = true;
      padAct(name, s).catch((e) => { padMsg = e.message; }).finally(() => { padBusy = false; });
    }
  }
  const mode = ftView === 'zoom' ? 'centre mode' : ftView === 'circle' ? 'circularity mode' : 'buttons off (Normal view)';
  $('ft-pad').innerHTML = `Controller: <b>${activeStick === null ? 'no stick chosen' : STICKS[activeStick].label}</b>, ${mode}. ` +
    '<kbd>L1</kbd> centre, <kbd>R1</kbd> circularity; D-pad or face buttons adjust; hold <kbd>L2</kbd>/<kbd>R2</kbd> ' +
    'at an edge to set it to 99%.' + (padMsg ? ` <span class="warn">${escapeHtml(padMsg)}</span>` : '');
}

// Entries saved before raw sticks went 16-bit hold 12-bit counts (no bits field): scale them the
// way the firmware scales a 12-bit reading (v << 4 | v >> 8), so a restore lands where it was.
function to16(e) {
  if (e.bits === 16) return e;
  const up = (a) => a.map((v) => (v << 4) | (v >> 8));
  return { ...e, bits: 16, min: up(e.min), centre: up(e.centre), max: up(e.max) };
}

function history() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]').map(to16); } catch { return []; }
}

function rememberCal() {
  const h = history();
  const entry = { t: Date.now(), board: boardName, bits: 16, min: cal.min, centre: cal.centre, max: cal.max };
  const same = (a) => JSON.stringify([a.min, a.centre, a.max]) === JSON.stringify([entry.min, entry.centre, entry.max]);
  if (h.length && same(h[0])) h[0].t = entry.t; else h.unshift(entry);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 10))); } catch { /* storage off */ }
  renderHistory();
}

function renderHistory() {
  const list = $('ft-history-list');
  const h = history();
  if (!h.length) {
    list.innerHTML = '<p class="muted" style="font-size:13px">None yet. Each save is kept here (up to 10).</p>';
    return;
  }
  list.innerHTML = '';
  h.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'hist-row';
    row.innerHTML = `<span>${new Date(e.t).toLocaleString()} <span class="muted">${escapeHtml(e.board || '')}</span></span>
      <button>Restore</button>`;
    row.querySelector('button').addEventListener('click', guard(async () => {
      const r = await call('CAL_SET', { min: e.min, centre: e.centre, max: e.max });
      setCal(r.fields);
      note('ft-msg', r.status === 'OK' ? 'Restored. Press Save to keep it.' : `Refused (${r.status}).`, r.status === 'OK');
    }));
    list.appendChild(row);
  });
}

// ------------------------------------------------------------------ settings

// ------------------------------------------------------------------ output mode

function showMode(current, canSwitch) {
  const sel = $('st-mode-sel');
  const name = (m) => MODE_NAME[ENUMS.output_mode[m]] ?? ENUMS.output_mode[m] ?? String(m);
  $('st-mode').textContent = name(current);
  $('st-mode').classList.toggle('hidden', canSwitch);
  sel.classList.toggle('hidden', !canSwitch);
  sel.innerHTML = ENUMS.output_mode.map((_, i) =>
    `<option value="${i}" ${i === current ? 'selected' : ''}>${escapeHtml(name(i))}</option>`).join('');
  sel.dataset.current = current;
  updateDispBits();
}

async function setMode() {
  const sel = $('st-mode-sel');
  const m = Number(sel.value);
  if (m === Number(sel.dataset.current)) return;
  const name = sel.options[sel.selectedIndex].text;
  if (!confirm(`Switch to ${name}? The controller restarts and comes back as a different USB device, `
    + 'so press Connect controller again and pick it.')) {
    sel.value = sel.dataset.current;
    return;
  }
  const r = await call('SET_MODE', { mode: m });
  if (r.status !== 'OK') {
    note('mode-msg', `Refused (${r.status}).`, false);
    sel.value = sel.dataset.current;
    return;
  }
  note('mode-msg', `Switching to ${name}: the controller is restarting. Press Connect controller when it is back.`, true);
}

// ------------------------------------------------------------------ settings

// Three columns: everything for the left stick, everything for the right stick, and the
// settings that belong to the whole controller. The controller says which is which (scope).
async function loadSettings() {
  const box = $('settings');
  box.innerHTML = '';
  const first = await call('SETTING_INFO', { index: 0 });
  const count = first.fields.count;
  if (!count) {
    box.innerHTML = '<p class="muted">No adjustable settings on this controller.</p>';
    return;
  }
  const infos = [first.fields];
  for (let i = 1; i < count; i++) infos.push((await call('SETTING_INFO', { index: i })).fields);
  for (const s of infos) {
    const g = (await call('GET_SETTING', { id: s.id })).fields;
    s.value = g.value;
    s.data = Array.from(g.data ?? []).slice(0, g.points ?? 0);
  }
  allSettings = infos;

  // The Output group sits in the Controller panel, beside the output mode it goes with
  const out = $('st-output');
  out.innerHTML = '';
  for (const s of infos.filter((x) => x.group === 'Output')) {
    const stat = document.createElement('div');
    stat.className = 'stat';
    const fill = () => {
      stat.innerHTML = `<div class="k">${escapeHtml(s.name)} <button class="info" data-setting="${s.id}"
        aria-label="About ${escapeHtml(s.name)}">i</button></div>`;
      const ctl = settingControl(s);
      ctl.classList.add('with-reset');
      ctl.appendChild(resetButton(s, () => { fill(); showModeNotes(); }));
      stat.appendChild(ctl);
    };
    fill();
    out.appendChild(stat);
  }
  showModeNotes();
  outBitsSetting = infos.find((x) => x.group === 'Output' && x.unit === 'bits') ?? null;
  updateDispBits();

  // CURVE and SECTORS settings get their editors on the Sticks tab
  const typeOf = (x) => ENUMS.setting_type[x.type];
  const sides = (t) => ['LEFT', 'RIGHT'].map((sc) => infos.find((x) => typeOf(x) === t && ENUMS.setting_scope?.[x.scope] === sc)).filter(Boolean);
  const curves = sides('CURVE');
  const shapes = sides('SECTORS');
  if (curves.length) initCurves($('curve-editor'), curves, saveData, restoreData);
  $('sec-curve').classList.toggle('hidden', !curves.length);
  if (shapes.length) { initShapes($('shape-editor'), shapes, saveData, call, calStep, restoreData); shapeCalState(lastCalState ?? 'IDLE'); }
  $('sec-shape').classList.toggle('hidden', !shapes.length);

  // Groups shown beside what they belong to; everything else is Advanced
  const PLACE = { Buttons: 'settings-buttons', Deadzone: 'settings-deadzone', Calibration: 'settings-cal', Shape: 'settings-shape' };
  const plain = infos.filter((x) => x.group !== 'Output' && typeOf(x) !== 'CURVE' && typeOf(x) !== 'SECTORS');
  for (const id of Object.values(PLACE)) $(id).innerHTML = '';
  for (const [g, id] of Object.entries(PLACE)) {
    const mine = plain.filter((x) => x.group === g);
    if (mine.length) renderColumns($(id), mine, false);
  }
  renderColumns(box, plain.filter((x) => !PLACE[x.group]), true);
}

// Settings in Left stick / Right stick / Controller columns, one heading per group
function renderColumns(box, list, headings) {
  const cols = { LEFT: 'Left stick', RIGHT: 'Right stick', ALL: 'Controller' };
  for (const [scope, title] of Object.entries(cols)) {
    const mine = list.filter((x) => (ENUMS.setting_scope?.[x.scope] ?? 'ALL') === scope);
    if (!mine.length && !headings) continue;
    const col = document.createElement('div');
    col.className = 'scol';
    col.innerHTML = `<h3>${title}</h3>`;
    if (!mine.length) col.insertAdjacentHTML('beforeend', '<p class="muted">Nothing here.</p>');
    const groups = [...new Set(mine.map((x) => x.group))];
    for (const g of groups) {
      if (headings || groups.length > 1) col.insertAdjacentHTML('beforeend', `<div class="group">${escapeHtml(g)}</div>`);
      for (const x of mine.filter((y) => y.group === g)) col.appendChild(settingRow(x));
    }
    box.appendChild(col);
  }
}

// CURVE / SECTORS: values travel in data[], points says how many
// CURVE / SECTORS back to the controller's own default (points = 0); returns the new values
async function restoreData(setting) {
  const r = await call('SET_SETTING', { id: setting.id, value: 0, points: 0, data: new Array(26).fill(0) });
  const side = { LEFT: ' (left stick)', RIGHT: ' (right stick)' }[ENUMS.setting_scope?.[setting.scope]] ?? '';
  note('settings-msg', r.status === 'OK' ? `${setting.name}${side}: back to default.` : `${setting.name}${side}: refused (${r.status}).`,
       r.status === 'OK');
  if (r.status !== 'OK') return null;
  setting.data = Array.from(r.fields.data).slice(0, r.fields.points);
  return setting.data;
}

async function saveData(setting, values) {
  const data = values.concat(new Array(26 - values.length).fill(0));
  const r = await call('SET_SETTING', { id: setting.id, value: 0, points: values.length, data });
  const side = { LEFT: ' (left stick)', RIGHT: ' (right stick)' }[ENUMS.setting_scope?.[setting.scope]] ?? '';
  if (r.status === 'OK') setting.data = values;
  note('settings-msg', r.status === 'OK' ? `${setting.name}${side}: saved.` : `${setting.name}${side}: refused (${r.status}).`,
       r.status === 'OK');
  return r.status;
}

// DualSense reports are 8 bits by format: say so beside the resolution control
function showModeNotes() {
  const ds = ENUMS.output_mode[Number($('st-mode-sel').dataset.current)] === 'DUALSENSE';
  for (const el of $('st-output').querySelectorAll('.stat')) {
    let n = el.querySelector('.sub');
    if (!n) el.appendChild(n = Object.assign(document.createElement('div'), { className: 'sub' }));
    n.textContent = ds && /bits/.test(el.textContent) ? 'DualSense always sends 8' : '';
  }
}

function settingRow(s) {
  const row = document.createElement('div');
  row.className = 'setting';
  const allp = profiles && !s.profile ? '<span class="allp" title="The same in every profile">all profiles</span>' : '';
  row.innerHTML = `<div class="name">${escapeHtml(s.name)}${allp}
      <button class="info" data-setting="${s.id}" aria-label="About ${escapeHtml(s.name)}">i</button></div>`;
  row.appendChild(settingControl(s));
  const def = document.createElement('div');
  def.className = 'muted def';
  def.innerHTML = `default ${escapeHtml(showValue(s, s.default_value))}`;
  def.appendChild(resetButton(s, () => row.replaceWith(settingRow(s))));
  row.appendChild(def);
  return row;
}

// Restore one setting to its default; greyed out while it already is. redraw rebuilds its control.
function resetButton(s, redraw) {
  const b = document.createElement('button');
  b.className = 'reset';
  b.textContent = '↺';
  b.title = `Restore the default (${showValue(s, s.default_value)})`;
  b.setAttribute('aria-label', `Restore ${s.name} to its default`);
  b.disabled = s.value === s.default_value;
  b.addEventListener('click', guard(async () => {
    await setSetting(s, s.default_value);
    redraw();
  }));
  s.onChange = () => { b.disabled = s.value === s.default_value; };
  return b;
}

// INT values are stored scaled: show value / 10^decimals
function showValue(s, v) {
  if (ENUMS.setting_type[s.type] === 'BOOL') return v ? 'on' : 'off';
  return `${(v / 10 ** (s.decimals || 0)).toFixed(s.decimals || 0)}${s.unit ? ' ' + s.unit : ''}`;
}

function settingControl(s) {
  const type = ENUMS.setting_type[s.type];
  const cell = document.createElement('div');
  cell.className = 'ctl';
  if (type === 'BOOL') {
    cell.innerHTML = `<input type="checkbox" ${s.value ? 'checked' : ''} aria-label="${escapeHtml(s.name)}">`;
    cell.querySelector('input').addEventListener('change', (e) => setSetting(s, e.target.checked ? 1 : 0));
  } else if (type === 'INT' && !s.decimals && s.max - s.min <= 16) {
    // A short whole-number range reads better as a list
    let opts = '';
    for (let v = s.min; v <= s.max; v++) {
      opts += `<option value="${v}" ${v === s.value ? 'selected' : ''}>${v}${s.unit ? ' ' + escapeHtml(s.unit) : ''}</option>`;
    }
    cell.innerHTML = `<select aria-label="${escapeHtml(s.name)}">${opts}</select>`;
    cell.querySelector('select').addEventListener('change', (e) => setSetting(s, Number(e.target.value)));
  } else if (type === 'INT') {
    cell.innerHTML = `<span class="val">${escapeHtml(showValue(s, s.value))}</span>
      <input type="range" min="${s.min}" max="${s.max}" value="${s.value}" aria-label="${escapeHtml(s.name)}">`;
    const range = cell.querySelector('input');
    const val = cell.querySelector('.val');
    range.addEventListener('input', () => { val.textContent = showValue(s, Number(range.value)); });
    range.addEventListener('change', () => setSetting(s, Number(range.value)));
  } else {
    cell.innerHTML = `<span class="muted">${escapeHtml(type ?? '?')}: editor coming</span>`;
  }
  return cell;
}

async function setSetting(s, value) {
  const r = await call('SET_SETTING', { id: s.id, value });
  const side = { LEFT: ' (left stick)', RIGHT: ' (right stick)' }[ENUMS.setting_scope?.[s.scope]] ?? '';
  if (r.status === 'OK') s.value = value;
  s.onChange?.();
  if (s === outBitsSetting) updateDispBits();
  note('settings-msg', r.status === 'OK' ? `${s.name}${side}: saved.` : `${s.name}${side}: refused (${r.status}).`,
       r.status === 'OK');
}

// ------------------------------------------------------------------ profiles
// The controller keeps 8 profiles; per-profile settings (SETTING_INFO.profile) and the button
// mapping read and change the one in use. A switch from the controller (FN + a button) is picked
// up by asking once a second.

let profiles = null;   // { active, count, names[] }
let profileTimer = null;
let profileBusy = false;
const profName = (i) => profiles.names[i] || `Profile ${i + 1}`;

async function loadProfiles() {
  const first = (await call('PROFILE_INFO', { index: 0 })).fields;
  const names = [first.name];
  for (let i = 1; i < first.count; i++) names.push((await call('PROFILE_INFO', { index: i })).fields.name);
  profiles = { active: first.active, count: first.count, names };
  renderProfiles();
}

function renderProfiles() {
  if (!profiles) return;
  const opts = (skip) => profiles.names.map((_, i) => (i === skip ? ''
    : `<option value="${i}" ${i === profiles.active ? 'selected' : ''}>${i + 1}. ${escapeHtml(profName(i))}</option>`)).join('');
  $('st-profile').innerHTML = opts(-1);
  $('st-profile').value = String(profiles.active);
  $('prof-copy-to').innerHTML = opts(profiles.active);
  $('prof-name').value = profiles.names[profiles.active];
  $('prof-tiles').innerHTML = '';
  profiles.names.forEach((_, i) => {
    const b = document.createElement('button');
    b.className = i === profiles.active ? 'on' : '';
    b.setAttribute('aria-pressed', String(i === profiles.active));
    b.innerHTML = `<span class="num">${i + 1}</span><span class="nm">${escapeHtml(profName(i))}</span>`;
    b.addEventListener('click', guard(() => useProfile(i)));
    $('prof-tiles').appendChild(b);
  });
  const keys = ['D-pad up', 'D-pad right', 'D-pad down', 'D-pad left', 'Triangle', 'Circle', 'Cross', 'Square'];
  $('prof-hint').textContent = `On the controller: hold FN and press ${keys[profiles.active] ?? ''} for this profile `
    + '(FN + D-pad up/right/down/left = 1-4, FN + Triangle/Circle/Cross/Square = 5-8). The light flashes the number.';
}

// Everything that depends on the profile in use
async function reloadProfileView() {
  if (hasFeat('SETTINGS')) await loadSettings();
  if (hasFeat('REMAP')) await loadRemap();
}

async function useProfile(i) {
  if (!profiles || i === profiles.active) return;
  profileBusy = true;
  try {
    const r = await call('PROFILE_SELECT', { index: i });
    if (r.status !== 'OK') { note('prof-msg', `Refused (${r.status}).`, false); return; }
    profiles.active = r.fields.active;
    renderProfiles();
    await reloadProfileView();
    note('prof-msg', `Now using ${profName(i)}.`, true);
  } finally { profileBusy = false; }
}

// A switch made on the controller itself
async function watchProfile() {
  if (!profiles || profileBusy) return;
  const f = (await call('PROFILE_INFO', { index: 0 })).fields;
  if (f.active === profiles.active || profileBusy) return;
  profileBusy = true;
  try {
    profiles.active = f.active;
    renderProfiles();
    await reloadProfileView();
    note('prof-msg', `Switched on the controller to ${profName(f.active)}.`, true);
  } finally { profileBusy = false; }
}

async function renameProfile() {
  const i = profiles.active;
  const nameIn = $('prof-name').value.replace(/[^\x20-\x7E]/g, '').trim().slice(0, 19);
  const r = await call('PROFILE_NAME', { index: i, name: nameIn });
  if (r.status === 'OK') profiles.names[i] = r.fields.name;
  renderProfiles();
  note('prof-msg', r.status === 'OK' ? 'Name saved.' : `Refused (${r.status}).`, r.status === 'OK');
}

async function copyProfile() {
  const to = Number($('prof-copy-to').value);
  if (!confirm(`Copy ${profName(profiles.active)} into profile ${to + 1} (${profName(to)})? `
    + `Everything in profile ${to + 1} is replaced.`)) return;
  const r = await call('PROFILE_COPY', { from: profiles.active, to });
  if (r.status === 'OK') profiles.names[to] = r.fields.name;
  renderProfiles();
  note('prof-msg', r.status === 'OK' ? `Copied into profile ${to + 1}.` : `Refused (${r.status}).`, r.status === 'OK');
}

async function resetProfile() {
  const i = profiles.active;
  if (!confirm(`Put ${profName(i)} back to the defaults? Its settings, button mapping and name are cleared. `
    + 'Calibration is not touched.')) return;
  profileBusy = true;
  try {
    const r = await call('PROFILE_RESET', { index: i });
    if (r.status === 'OK') profiles.names[i] = r.fields.name;
    renderProfiles();
    await reloadProfileView();
    note('prof-msg', r.status === 'OK' ? 'Back to the defaults.' : `Refused (${r.status}).`, r.status === 'OK');
  } finally { profileBusy = false; }
}

// ------------------------------------------------------------------ save and load (a file on the PC)
// The file holds every setting by id, as this controller reports them (names are only there to
// read), the button mapping by button name, and optionally the stick calibration. Loading
// compares it with the controller and applies only what differs, once the user has seen the list.
// The controller checks every value itself and refuses what it doesn't accept.

let allSettings = [];
let feats = 0;
const hasFeat = (f) => (feats >> ENUMS.feature.indexOf(f)) & 1;
const FILE_KIND = 'thirst-config';
const FILE_FORMAT = 1;
const scopeOf = (s) => ENUMS.setting_scope?.[s.scope] ?? 'ALL';
const sideOf = (s) => ({ LEFT: ' (left stick)', RIGHT: ' (right stick)' }[scopeOf(s)] ?? '');
const isData = (s) => ['CURVE', 'SECTORS'].includes(ENUMS.setting_type[s.type]);
const mapName = (t) => (t === REMAP_SELF ? 'Itself' : name(t));

async function buildFile() {
  const file = {
    kind: FILE_KIND, format: FILE_FORMAT,
    name: $('file-name').value.trim() || (profiles ? profiles.names[profiles.active] : ''),
    saved: new Date().toISOString(), board: boardName, firmware: $('st-fw').textContent, settings: [],
  };
  if (profiles) file.profile = profiles.active + 1;
  for (const s of allSettings) {
    const e = { id: s.id, name: s.name, scope: scopeOf(s) };
    if (isData(s)) e.data = s.data.slice(); else e.value = s.value;
    file.settings.push(e);
  }
  if (hasFeat('REMAP')) {
    const { active } = (await call('GET_REMAP')).fields;
    file.mapping = {};
    active.forEach((t, i) => {
      if (ENUMS.button[i] && (t === REMAP_SELF || ENUMS.button[t])) file.mapping[ENUMS.button[i]] = t === REMAP_SELF ? 'SELF' : ENUMS.button[t];
    });
  }
  if ($('file-cal').checked && hasFeat('CALIBRATION') && cal) {
    file.calibration = { bits: 16, min: [...cal.min], centre: [...cal.centre], max: [...cal.max] };
  }
  return file;
}

async function saveFile() {
  const file = await buildFile();
  // One line per setting, mapping entry and calibration row, so the file reads easily.
  // (JSON.stringify escapes newlines inside strings, so every real newline is layout.)
  const one = (v) => JSON.stringify(v, null, 1).replace(/\n\s*/g, ' ');
  const text = `{\n${Object.entries(file).map(([k, v]) => {
    if (Array.isArray(v)) return `  ${JSON.stringify(k)}: [\n${v.map((e) => `    ${one(e)}`).join(',\n')}\n  ]`;
    if (v && typeof v === 'object') {
      return `  ${JSON.stringify(k)}: {\n${Object.entries(v).map(([a, b]) => `    ${JSON.stringify(a)}: ${one(b)}`).join(',\n')}\n  }`;
    }
    return `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  }).join(',\n')}\n}\n`;
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const base = (file.name || `thirst-${boardName}`).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'thirst';
  const fname = `${base}-${day}.json`;
  if (window.showSaveFilePicker) {
    // Chrome and Edge: a normal Save dialog, starting on the desktop
    try {
      const h = await window.showSaveFilePicker({
        suggestedName: fname, startIn: 'desktop',
        types: [{ description: 'Thirst settings', accept: { 'application/json': ['.json'] } }],
      });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      note('file-msg', `Saved ${h.name}.`, true);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;   // cancelled
      // otherwise fall back to a download
    }
  }
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: fname,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  note('file-msg', `Saved ${fname} to your downloads folder.`, true);
}

// What loading this file would change, against what the controller has now
async function planFile(file) {
  const byId = new Map(allSettings.map((s) => [s.id, s]));
  const plan = { file, settings: [], skipped: 0, mapping: [], cal: null };
  for (const e of file.settings) {
    const s = byId.get(Number(e.id));
    if (!s || isData(s) !== Array.isArray(e.data)) { plan.skipped++; continue; }
    if (isData(s)) {
      const data = e.data.slice(0, 26).map((v) => Math.max(0, Math.min(65535, Math.round(Number(v) || 0))));
      if (JSON.stringify(data) !== JSON.stringify(s.data)) plan.settings.push({ s, data });
    } else {
      const v = Math.round(Number(e.value));
      if (!Number.isFinite(v)) { plan.skipped++; continue; }
      if (v !== s.value) plan.settings.push({ s, value: v });
    }
  }
  if (file.mapping && typeof file.mapping === 'object' && hasFeat('REMAP')) {
    const { active } = (await call('GET_REMAP')).fields;
    for (const [src, tgt] of Object.entries(file.mapping)) {
      const i = ENUMS.button.indexOf(src);
      const t = tgt === 'SELF' ? REMAP_SELF : ENUMS.button.indexOf(tgt);
      if (i < 0 || i >= active.length || t < 0) { plan.skipped++; continue; }
      if (active[i] !== t) plan.mapping.push({ i, t, was: active[i] });
    }
  }
  const c = file.calibration;
  if (c && hasFeat('CALIBRATION') && cal) {
    const n = cal.min.length;
    const ok = c.bits === 16 && ['min', 'centre', 'max'].every((k) => Array.isArray(c[k]) && c[k].length === n);
    if (!ok) plan.skipped++;
    else if (['min', 'centre', 'max'].some((k) => c[k].some((v, j) => v !== cal[k][j]))) plan.cal = c;
  }
  return plan;
}

function showPlan(plan) {
  const box = $('file-preview');
  const f = plan.file;
  const when = Number.isNaN(Date.parse(f.saved)) ? '' : `, saved ${new Date(f.saved).toLocaleString()}`;
  const from = `${f.name ? `"${escapeHtml(String(f.name))}"` : 'This file'}${escapeHtml(when)}`
    + `${f.board ? ` on ${escapeHtml(String(f.board))}` : ''}${f.firmware ? `, firmware ${escapeHtml(String(f.firmware))}` : ''}`;
  const val = (c) => (c.data ? 'changed' : `${escapeHtml(showValue(c.s, c.s.value))} → ${escapeHtml(showValue(c.s, c.value))}`);
  const part = (key, title, n, items, checked) => (n ? `<div class="part"><label class="check"><input type="checkbox"
      data-part="${key}" ${checked ? 'checked' : ''}> ${title}</label>${items ? `<ul>${items}</ul>` : ''}</div>` : '');
  let html = `<p>${from}.</p>`;
  if (profiles) html += `<p>Goes into the profile in use: <b>${profiles.active + 1}. ${escapeHtml(profName(profiles.active))}</b>.</p>`;
  html += part('settings', `Settings: ${plan.settings.length} different`, plan.settings.length,
    plan.settings.map((c) => `<li><b>${escapeHtml(c.s.name)}${escapeHtml(sideOf(c.s))}</b>: ${val(c)}</li>`).join(''), true);
  html += part('mapping', `Button mapping: ${plan.mapping.length} different`, plan.mapping.length,
    plan.mapping.map((m) => `<li><b>${escapeHtml(name(m.i))}</b>: ${escapeHtml(mapName(m.was))} → ${escapeHtml(mapName(m.t))}</li>`).join(''), true);
  // Calibration is for one controller's sticks, so it is never ticked for you
  html += part('cal', 'Stick calibration (only if this file came from this same controller)', plan.cal ? 1 : 0, '', false);
  if (!plan.settings.length && !plan.mapping.length && !plan.cal) html += '<p>Nothing to change: the controller already matches this file.</p>';
  if (plan.skipped) {
    html += `<p class="muted">Left out: ${plan.skipped} entr${plan.skipped === 1 ? 'y' : 'ies'} this controller doesn't have.</p>`;
  }
  html += `<div class="row"><button class="primary" data-act="apply" ${plan.settings.length || plan.mapping.length || plan.cal ? '' : 'disabled'}>Apply</button>
    <button data-act="cancel">Cancel</button></div>`;
  box.innerHTML = html;
  box.classList.remove('hidden');
  box.querySelector('[data-act=apply]').addEventListener('click', guard(() => applyPlan(plan)));
  box.querySelector('[data-act=cancel]').addEventListener('click', closePlan);
}

function closePlan() {
  $('file-preview').classList.add('hidden');
  $('file-preview').innerHTML = '';
}

async function applyPlan(plan) {
  const on = (k) => $('file-preview').querySelector(`[data-part=${k}]`)?.checked;
  const bad = [];
  let done = 0;
  if (on('settings')) {
    for (const c of plan.settings) {
      const r = c.data
        ? await call('SET_SETTING', { id: c.s.id, value: 0, points: c.data.length, data: c.data.concat(new Array(26 - c.data.length).fill(0)) })
        : await call('SET_SETTING', { id: c.s.id, value: c.value });
      if (r.status === 'OK') done++; else bad.push(`${c.s.name}${sideOf(c.s)} (${r.status})`);
    }
  }
  if (on('mapping')) {
    for (const m of plan.mapping) {
      const r = await call('SET_REMAP', { source: m.i, target: m.t });
      if (r.status === 'OK') done++; else bad.push(`${name(m.i)} mapping (${r.status})`);
    }
  }
  if (on('cal') && plan.cal) {
    const r = await call('CAL_SET', { min: plan.cal.min, centre: plan.cal.centre, max: plan.cal.max });
    const s = r.status === 'OK' ? await call('CAL_SAVE') : r;
    if (s.status === 'OK') { done++; setCal(s.fields); rememberCal(); } else bad.push(`calibration (${s.status})`);
  }
  closePlan();
  if (hasFeat('SETTINGS')) await loadSettings();
  if (hasFeat('REMAP')) await loadRemap();
  if (hasFeat('CALIBRATION')) await loadCal();
  note('file-msg', bad.length ? `Applied ${done}; refused: ${bad.join(', ')}.` : `Applied ${done} change${done === 1 ? '' : 's'}.`,
       !bad.length);
}

async function loadFile(f) {
  let file;
  try { file = JSON.parse(await f.text()); } catch { note('file-msg', `${f.name} is not a settings file.`, false); return; }
  if (file?.kind !== FILE_KIND || !Array.isArray(file.settings)) {
    note('file-msg', `${f.name} is not a Thirst settings file.`, false);
    return;
  }
  if (file.format > FILE_FORMAT) note('file-msg', 'This file is from a newer page; anything it doesn\'t understand is left out.', false);
  showPlan(await planFile(file));
}

// ------------------------------------------------------------------ performance (Controller banner)

let statsTimer = null;

async function loadStats() {
  const w = (await call('GET_STATS')).fields;
  const secs = w.window_ms / 1000;
  if (secs <= 0) return;
  const pollHz = w.polls / secs;
  $('st-poll').textContent = `${Math.round(pollHz)} Hz`;
  $('st-poll-sub').textContent = `controller runs at ${Math.round(1e6 / w.beat_us)} Hz`;

  const judged = w.hits + w.misses + w.dropped;
  $('st-miss').textContent = judged ? `${(100 * (w.misses + w.dropped) / judged).toFixed(2)} %` : '-';
  $('st-miss-sub').textContent = judged ? `${w.misses + w.dropped} of ${judged} last second` : '';

  // Report age: 100 us buckets, the last one 1 ms and over (counted as 1.1 ms)
  const n = w.age_hist.reduce((a, b) => a + b, 0);
  if (n) {
    const mid = (i) => (i < w.age_hist.length - 1 ? i * 100 + 50 : 1100);
    const mean = w.age_hist.reduce((a, c, i) => a + c * mid(i), 0) / n;
    let acc = 0;
    let p99 = 0;
    for (let i = 0; i < w.age_hist.length; i++) {
      acc += w.age_hist[i];
      if (acc >= 0.99 * n) { p99 = (i + 1) * 100; break; }
    }
    // A press lands at a random point between samples: half a beat on average, a whole beat at worst
    $('st-delay').textContent = `${((mean + w.beat_us / 2) / 1000).toFixed(2)} ms`;
    $('st-delay-sub').textContent = `worst about ${((p99 + w.beat_us) / 1000).toFixed(2)} ms`;
  }
}

// ------------------------------------------------------------------ (i) explanations

async function toggleInfo(btn) {
  const open = btn.getAttribute('aria-expanded') === 'true';
  // Where the text goes: under a section heading, under a banner figure, or inside a setting row
  const host = btn.closest('.setting') || btn.closest('.stat') || btn.closest('section');
  const key = btn.dataset.info || `setting-${btn.dataset.setting}`;
  let box = host.querySelector(`.info-text[data-for="${key}"]`);
  if (open) {
    btn.setAttribute('aria-expanded', 'false');
    box?.remove();
    return;
  }
  btn.setAttribute('aria-expanded', 'true');
  box = document.createElement('p');
  box.className = 'info-text';
  box.dataset.for = key;
  if (btn.dataset.info) {
    box.textContent = INFO[btn.dataset.info] ?? '';
  } else {
    box.textContent = '...';
    box.textContent = await settingHelp(Number(btn.dataset.setting));
  }
  if (host.classList.contains('setting')) host.appendChild(box);
  else if (host.classList.contains('stat')) host.appendChild(box);
  else host.querySelector('h2').after(box);
}

const helpCache = new Map();

async function settingHelp(id) {
  if (helpCache.has(id)) return helpCache.get(id);
  const first = await call('SETTING_HELP', { id, part: 0 });
  if (first.status !== 'OK') return 'No description.';
  let text = first.fields.text;
  for (let p = 1; p < first.fields.parts; p++) text += (await call('SETTING_HELP', { id, part: p })).fields.text;
  helpCache.set(id, text);
  return text;
}

// ------------------------------------------------------------------ fault

async function loadFault() {
  const f = (await call('GET_FAULT')).fields;
  $('fault').textContent = f.present
    ? `Reason ${f.reason} in thread "${f.thread}" after ${(f.uptime_ms / 1000).toFixed(1)} s ` +
      `(pc 0x${f.pc.toString(16)}, lr 0x${f.lr.toString(16)}). ${f.count} since power-up.`
    : 'None since power-up.';
}

// ------------------------------------------------------------------ helpers and wiring

function note(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.className = `msg ${ok ? 'ok' : 'bad'}`;
  if (ok && text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2500);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function guard(fn) {
  return async (...a) => {
    try { await fn(...a); } catch (e) { $('status').textContent = `Error: ${e.message}`; }
  };
}

$('connect').addEventListener('click', guard(async () => {
  const [d] = await navigator.hid.requestDevice({ filters: DEVICES });
  if (d) await connect(d);
}));
$('disconnect').addEventListener('click', guard(disconnect));
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
buildFolds();
try { showTab(localStorage.getItem('thirst.tab') || 'home'); } catch { showTab('home'); }
$('cal-start').addEventListener('click', guard(() => calStep('RANGE')));
$('st-mode-sel').addEventListener('change', guard(setMode));
$('cal-centre').addEventListener('click', guard(() => calStep(lastCalState === 'RANGE' ? 'CENTRE' : 'RECENTRE')));
$('cal-cancel').addEventListener('click', guard(() => calStep('CANCEL')));
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button.info');
  if (btn) { e.stopPropagation(); guard(toggleInfo)(btn); }
});
document.querySelectorAll('.view-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
document.querySelectorAll('.ft-stick').forEach((el) => el.addEventListener('click', () => setActive(Number(el.dataset.stick))));
// Arrow keys act as the D-pad while a fine-tune mode is on
window.addEventListener('keydown', (e) => {
  const k = KEYMAP[e.key];
  if (k && cal && (ftView === 'zoom' || ftView === 'circle') && !(e.target instanceof HTMLSelectElement)) {
    keys.add(k);
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => { const k = KEYMAP[e.key]; if (k) keys.delete(k); });
buildSteps();
// Remember the step per resolution
$('ft-step').addEventListener('change', () => {
  try { localStorage.setItem(`thirst.ftStep.${dispBits}`, $('ft-step').value); } catch { /* storage off */ }
  labelRowButtons();
});
$('ft-circle-reset').addEventListener('click', () => trace.forEach((t) => t.fill(0)));
$('ft-save').addEventListener('click', guard(async () => {
  const r = await call('CAL_SAVE');
  setCal(r.fields);
  rememberCal();
  await loadCal();
  note('ft-msg', 'Saved on the controller.', true);
}));
$('ft-revert').addEventListener('click', guard(async () => {
  const r = await call('CAL_REVERT');
  setCal(r.fields);
  await loadCal();
  note('ft-msg', 'Back to the saved calibration.', true);
}));
$('fault-clear').addEventListener('click', guard(async () => { await call('CLEAR_FAULT'); await loadFault(); }));
$('st-profile').addEventListener('change', guard(() => useProfile(Number($('st-profile').value))));
$('prof-rename').addEventListener('click', guard(renameProfile));
$('prof-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') guard(renameProfile)(); });
$('prof-copy').addEventListener('click', guard(copyProfile));
$('prof-reset').addEventListener('click', guard(resetProfile));
$('file-save').addEventListener('click', guard(saveFile));
$('file-load').addEventListener('click', () => $('file-pick').click());
$('file-pick').addEventListener('change', guard(async (e) => {
  const f = e.target.files[0];
  e.target.value = '';   // so picking the same file again still fires
  if (f) await loadFile(f);
}));

if (!('hid' in navigator)) {
  $('connect').disabled = true;
  $('no-webhid').classList.remove('hidden');
} else {
  navigator.hid.addEventListener('disconnect', (e) => { if (e.device === dev) disconnect(); });
  // Reconnect to a controller this page was already allowed to use
  navigator.hid.getDevices().then((list) => {
    const d = list.find((x) => x.collections.some((c) => c.usagePage === HID_USAGE_PAGE));
    if (d) guard(connect)(d);
  });
}
