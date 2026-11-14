// Button bindings for a keyboard-and-mouse controller: what each button presses (a key, a mouse
// button, or nothing), for the profile in use. Press a key or click to bind it, or pick from
// the list. The controller checks every value and keeps the defaults.

import { ENUMS, KBM_KEYS, KBM_BIND, KBM_MOUSE_BUTTONS } from './contract.js';

const USAGE_NAME = Object.fromEntries(Object.entries(KBM_KEYS).map(([n, u]) => [u, n]));
const MOUSE = ['Left click', 'Right click', 'Middle click', 'Back', 'Forward'].slice(0, KBM_MOUSE_BUTTONS);
const FRIENDLY = {
  RT: 'RT', LT: 'LT', ALPS: 'Stick click', HOME: 'Home', TAB: 'Tab', MAP: 'Map', BOTTOM_L: 'Bottom L',
  RB: 'RB', RB2: 'RB2', BOTTOM_R: 'Bottom R', X: 'X', Y: 'Y', B: 'B', A: 'A',
  SCROLL_BTN: 'Scroll button', LB: 'LB', LB2: 'LB2', MIC: 'Mic', DPAD_UP: 'D-pad up',
  DPAD_RIGHT: 'D-pad right', DPAD_DOWN: 'D-pad down', DPAD_LEFT: 'D-pad left', SPARE: 'Spare (B7)',
};
const GROUPS = [
  ['Triggers', ['RT', 'LT']],
  ['Bumpers', ['LB', 'LB2', 'RB', 'RB2']],
  ['Top buttons', ['HOME', 'TAB', 'MAP', 'MIC']],
  ['Bottom buttons', ['BOTTOM_L', 'BOTTOM_R']],
  ['Face buttons', ['A', 'B', 'X', 'Y']],
  ['Stick and scroll', ['ALPS', 'SCROLL_BTN']],
  ['D-pad', ['DPAD_UP', 'DPAD_RIGHT', 'DPAD_DOWN', 'DPAD_LEFT']],
];

export const tbName = (i) => FRIENDLY[ENUMS.tb_button[i]] ?? ENUMS.tb_button[i] ?? `#${i}`;

export function bindLabel(b) {
  if (!b) return 'Nothing';
  const kind = b & 0xFF00;
  const code = b & 0xFF;
  if (kind === KBM_BIND.key) return USAGE_NAME[code] ?? `Key 0x${code.toString(16)}`;
  if (kind === KBM_BIND.mouse) return MOUSE[code] ?? `Mouse ${code + 1}`;
  return '?';
}

// For files: 'key:Space', 'mouse:0', 'none' (readable, and the same names the contract uses)
export function bindText(b) {
  if (!b) return 'none';
  const kind = b & 0xFF00;
  const code = b & 0xFF;
  if (kind === KBM_BIND.key && USAGE_NAME[code]) return `key:${USAGE_NAME[code]}`;
  if (kind === KBM_BIND.mouse) return `mouse:${code}`;
  return null;
}

export function bindFromText(t) {
  if (t === 'none') return 0;
  const [kind, val] = String(t).split(/:(.*)/s);
  if (kind === 'key' && KBM_KEYS[val] !== undefined) return KBM_BIND.key | KBM_KEYS[val];
  if (kind === 'mouse' && /^\d$/.test(val) && Number(val) < KBM_MOUSE_BUTTONS) return KBM_BIND.mouse | Number(val);
  return null;
}

// KeyboardEvent.code -> key name in KBM_KEYS
const CODE_NAMES = {
  Enter: 'Enter', Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab', Space: 'Space', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', IntlBackslash: '\\', Semicolon: ';', Quote: "'",
  Backquote: '`', Comma: ',', Period: '.', Slash: '/', CapsLock: 'Caps Lock', PrintScreen: 'Print Screen',
  ScrollLock: 'Scroll Lock', Pause: 'Pause', Insert: 'Insert', Home: 'Home', PageUp: 'Page Up', Delete: 'Delete',
  End: 'End', PageDown: 'Page Down', ArrowRight: 'Right', ArrowLeft: 'Left', ArrowDown: 'Down', ArrowUp: 'Up',
  NumLock: 'Num Lock', NumpadDivide: 'Keypad /', NumpadMultiply: 'Keypad *', NumpadSubtract: 'Keypad -',
  NumpadAdd: 'Keypad +', NumpadEnter: 'Keypad Enter', NumpadDecimal: 'Keypad .',
  ControlLeft: 'Left Ctrl', ShiftLeft: 'Left Shift', AltLeft: 'Left Alt', MetaLeft: 'Left Win',
  ControlRight: 'Right Ctrl', ShiftRight: 'Right Shift', AltRight: 'Right Alt', MetaRight: 'Right Win',
};
function codeToName(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(code))) return `Keypad ${m[1]}`;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return CODE_NAMES[code] ?? null;
}

let st = null;   // { host, call, note, guard, binds, changed, present, layer }
let capturing = null;   // { box, onPick }

// layer: 0 the main page, 1 the aim page (in use while LT is held)
export async function initBinds(host, call, note, guard) {
  st = { host, call, note, guard, layer: st?.layer ?? 0 };
  await load();
}

async function load(reply) {
  const r = reply ?? await st.call('GET_BINDS', { layer: st.layer });
  st.binds = Array.from(r.fields.binds);
  st.changed = r.fields.changed;
  st.present = r.fields.present;
  render();
}

async function setBind(i, b) {
  const r = await st.call('SET_BIND', { source: i, bind: b, layer: st.layer });
  const page = st.layer ? ' (aim page)' : '';
  const back = st.layer ? 'as the main page' : 'back to default';
  st.note(r.status === 'OK' ? `${tbName(i)}${page}: ${b === KBM_BIND.default ? back : bindLabel(b)}.` : `Refused (${r.status}).`,
    r.status === 'OK');
  endCapture();
  await load(r);
}

function options(cur) {
  const mouse = MOUSE.map((m, k) => `<option value="${KBM_BIND.mouse | k}">${m}</option>`).join('');
  const keys = Object.entries(KBM_KEYS).map(([n, u]) => `<option value="${KBM_BIND.key | u}">${escapeHtml(n)}</option>`).join('');
  return `<option value="" disabled ${cur === undefined ? 'selected' : ''}>Pick from the list</option>
    <optgroup label="Mouse">${mouse}</optgroup><optgroup label="Keyboard">${keys}</optgroup>
    <option value="0">Nothing (off)</option>`;
}

function render() {
  const host = st.host;
  host.innerHTML = '';
  // The two pages: main, and aim (while LT is held). An aim binding left alone is the main one.
  const pages = document.createElement('div');
  pages.className = 'row';
  pages.style.marginTop = '0';
  pages.innerHTML = `<span class="muted">Page:</span>
    <button data-layer="0" class="${st.layer ? '' : 'active'}" aria-pressed="${!st.layer}">Main</button>
    <button data-layer="1" class="${st.layer ? 'active' : ''}" aria-pressed="${!!st.layer}">Aim (LT held)</button>
    <span class="muted small">${st.layer ? 'While LT is held these replace the main page. A button left as default does what it does on the main page.' : 'What each button does normally.'}</span>`;
  pages.querySelectorAll('[data-layer]').forEach((b) => b.addEventListener('click', st.guard(async () => {
    st.layer = Number(b.dataset.layer);
    endCapture();
    await load();
  })));
  host.appendChild(pages);
  const has = (i) => (st.present >>> i) & 1;
  const known = new Set(GROUPS.flatMap(([, ks]) => ks));
  const groups = GROUPS.concat([['Other', ENUMS.tb_button.filter((b) => !known.has(b))]]);
  for (const [title, keys] of groups) {
    const idx = keys.map((k) => ENUMS.tb_button.indexOf(k)).filter((i) => i >= 0 && has(i));
    if (!idx.length) continue;
    const g = document.createElement('div');
    g.className = 'map-group';
    g.innerHTML = `<div class="group">${escapeHtml(title)}</div>`;
    for (const i of idx) {
      const changed = (st.changed >>> i) & 1;
      const row = document.createElement('div');
      row.className = 'map-row bind-row';
      row.innerHTML = `<div>${escapeHtml(tbName(i))} ${changed ? '<span class="changed">changed</span>' : ''}</div>
        <button class="bind-pill" title="Change what ${escapeHtml(tbName(i))} presses">${escapeHtml(bindLabel(st.binds[i]))}</button>
        <button ${changed ? '' : 'disabled'} data-act="def">Default</button>`;
      row.querySelector('.bind-pill').addEventListener('click', () => captureBinding(row, tbName(i), (b) => st.guard(() => setBind(i, b))()));
      row.querySelector('[data-act=def]').addEventListener('click', st.guard(() => setBind(i, KBM_BIND.default)));
      g.appendChild(row);
    }
    host.appendChild(g);
  }
  const n = ENUMS.tb_button.filter((_, i) => has(i) && (st.changed >>> i) & 1).length;
  const foot = document.createElement('div');
  foot.className = 'row';
  foot.innerHTML = `<button ${n ? '' : 'disabled'}>Reset all to default</button>
    <span class="muted small">${n ? `${n} ${st.layer ? 'differ from the main page' : 'changed in this profile'}` : (st.layer ? 'Every button as on the main page' : 'All buttons as they come')}. Click a binding to change it.</span>`;
  foot.querySelector('button').addEventListener('click', st.guard(resetAll));
  host.appendChild(foot);
}

async function resetAll() {
  let last = null;
  for (let i = 0; i < st.binds.length; i++) {
    if ((st.changed >>> i) & 1) last = await st.call('SET_BIND', { source: i, bind: KBM_BIND.default, layer: st.layer });
  }
  st.note(st.layer ? 'The aim page is the main page again.' : 'Every button back to its default.', true);
  await load(last ?? undefined);
}

// ------------------------------------------------------------------ capture: press a key or click

// Below row: press a key, click with a mouse button, or pick from the list. onPick(binding).
// Used for the buttons and for settings that are a binding (walk key, tilt keys, lean keys).
export function captureBinding(row, label, onPick, allowNone = true) {
  endCapture();
  const box = document.createElement('div');
  box.className = 'bind-capture';
  box.innerHTML = `<div class="bind-target" tabindex="0">Press a key, or click here with any mouse button</div>
    <div class="row" style="margin-top:6px">
      <select aria-label="Pick what ${escapeHtml(label)} presses">${options()}</select>
      <button data-act="cancel">Cancel</button>
    </div>`;
  if (!allowNone) box.querySelector('option[value="0"]')?.remove();
  row.after(box);
  const target = box.querySelector('.bind-target');
  const pick = (b) => { endCapture(); onPick(b); };
  target.focus();
  target.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const k = [0, 2, 1, 3, 4][e.button];   // DOM left, middle, right, back, forward -> HID order
    if (k !== undefined && k < KBM_MOUSE_BUTTONS) pick(KBM_BIND.mouse | k);
  });
  target.addEventListener('contextmenu', (e) => e.preventDefault());
  box.querySelector('select').addEventListener('change', (e) => pick(Number(e.target.value)));
  box.querySelector('[data-act=cancel]').addEventListener('click', endCapture);
  capturing = { box, pick };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);   // Print Screen only arrives on key up
}

function takeKey(e) {
  if (!capturing) return;
  if (e.target instanceof HTMLSelectElement) return;   // typing in the list: leave it alone
  const nm = codeToName(e.code);
  e.preventDefault();
  e.stopPropagation();
  if (!nm || KBM_KEYS[nm] === undefined) {
    capturing.box.querySelector('.bind-target').textContent = `That key (${e.code || e.key}) can't be sent; pick from the list instead`;
    return;
  }
  capturing.pick(KBM_BIND.key | KBM_KEYS[nm]);
}

function onKey(e) {
  if (e.code === 'PrintScreen') return;
  takeKey(e);
}

function onKeyUp(e) {
  if (e.code === 'PrintScreen') takeKey(e);
}

function endCapture() {
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('keyup', onKeyUp, true);
  capturing?.box.remove();
  capturing = null;
}

// ------------------------------------------------------------------ save and load

// layer 1 (the aim page): only the buttons bound differently from the main page, so the rest go
// on following it when the file is loaded
export async function bindsForFile(call, layer = 0) {
  const r = (await call('GET_BINDS', { layer })).fields;
  const out = {};
  ENUMS.tb_button.forEach((b, i) => {
    if ((r.present >>> i) & 1 && (!layer || (r.changed >>> i) & 1)) {
      const t = bindText(r.binds[i]);
      if (t) out[b] = t;
    }
  });
  return out;
}

// [{ i, b, was }] for the bindings in the file that differ; skipped counts the unusable ones
export async function planBinds(fileBinds, call, layer = 0) {
  const r = (await call('GET_BINDS', { layer })).fields;
  const changes = [];
  let skipped = 0;
  for (const [name, text] of Object.entries(fileBinds)) {
    const i = ENUMS.tb_button.indexOf(name);
    const b = bindFromText(text);
    if (i < 0 || b === null || !((r.present >>> i) & 1)) { skipped++; continue; }
    if (r.binds[i] !== b) changes.push({ i, b, was: r.binds[i], layer });
  }
  return { changes, skipped };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
