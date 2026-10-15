'use strict';

/**
 * The medallion's renderer: a way back to the pet, plus the two numbers that
 * matter while it is away.
 *
 * The ring around the face is the context gauge and the tag underneath is the
 * pair of readings — context first, because that is what runs out mid-task, then
 * the balance. Clicking anywhere calls the pet back; the window disappears the
 * moment it returns, so there is nothing here to dismiss.
 *
 * Dragging is deliberately dumb: the renderer only says "the pointer moved", and
 * the main process reads the cursor itself. See the note in ../src/pet.js — the
 * renderer's screen coordinates are in CSS pixels, which page zoom redefines,
 * while the window is placed in device-independent pixels.
 */

const api = window.dsh;

const hint = document.getElementById('hint');
const face = document.getElementById('face');
const ringFill = document.getElementById('ringFill');
const tagCtx = document.getElementById('tagCtx');
const tagMoney = document.getElementById('tagMoney');

const CIRCUMFERENCE = 2 * Math.PI * 49;   // r=49, matching launcher.html

let firstState = true;
let hintTimer = null;
let faceUrl = null;

// ------------------------------------------------------------------- render ---
function render(state) {
  if (!state) return;
  const { tokens, balance, compact } = state;

  document.body.dataset.busy = tokens.busy ? 'on' : 'off';

  const percent = compact.contextPercent;
  if (percent == null) {
    ringFill.style.strokeDashoffset = String(CIRCUMFERENCE);
    ringFill.className.baseVal = 'ring-fill';
    tagCtx.textContent = '—';
    tagCtx.className = 'v';
  } else {
    const clamped = Math.min(100, Math.max(0, percent));
    ringFill.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - clamped / 100));
    const level = clamped > 85 ? 'bad' : clamped > 65 ? 'warn' : '';
    ringFill.className.baseVal = level ? `ring-fill ${level}` : 'ring-fill';
    tagCtx.textContent = `${percent}%`;
    tagCtx.className = level ? `v ${level}` : 'v';
  }

  if (balance && balance.ok) {
    tagMoney.textContent = compact.balance;
    const low = Number.isFinite(balance.total) && balance.total < 10;
    tagMoney.className = low ? 'v warn' : 'v good';
  } else {
    tagMoney.textContent = '—';
    tagMoney.className = 'v bad';
  }

  if (firstState) {
    firstState = false;
    // The medallion is how a hidden pet comes back, and nothing on screen says
    // so. Say it once, when it first appears, then never again.
    hint.classList.add('on');
    hintTimer = setTimeout(() => hint.classList.remove('on'), 5000);
  }
}

// --------------------------------------------------------------- hit testing ---
/**
 * Is the cursor on the medallion?
 *
 * This window is 148x176 and the medallion is a circle inside it, so the test is
 * geometry rather than art alpha: cheaper, and exact for a disc. The target is
 * the *ring* — the outer circle the user sees — grown a few pixels, because a
 * 49px-radius target is small enough that demanding pixel precision feels broken.
 *
 * The main process spawns this window click-through (see applyClickThrough in
 * ../src/pet.js) and this is what decides when to take the mouse back.
 */
const RING_RADIUS = 54;      // SVG r=49 plus the stroke width
const GRAB_PAD = 6;          // forgiving edge: a small round target needs it

let armed = null;

function hitsMedalAt(px, py) {
  const medal = document.getElementById('medal');
  if (!medal) return true;
  const box = medal.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return true;
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  // The ring is drawn inside a 108-unit viewBox scaled to the medal box.
  const scale = Math.min(box.width, box.height) / 108;
  const radius = RING_RADIUS * scale + GRAB_PAD;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function setInteractive(on) {
  if (on === armed) return;
  armed = on;
  if (DEBUG_HIT) {
    try { console.log(`launcher hit ${on ? 'ON ' : 'off'}`); } catch { /* ignore */ }
  }
  call(api.launcherSetInteractive(on));
}

/** Debug the medallion's hit test (enable with DSH_PET_DEBUG_HIT=1). */
const DEBUG_HIT = (() => {
  try { return location.search.includes('debughit'); } catch { return false; }
})();

// ------------------------------------------------------------------ gestures --
let dragging = false;
let moved = 0;
let pending = false;
let frameRequested = false;

document.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 && event.button != null) return;
  dragging = true;
  moved = 0;
  document.body.classList.add('dragging');
  call(api.launcherDragBegin());
  if (document.body.setPointerCapture) {
    try { document.body.setPointerCapture(event.pointerId); } catch { /* ignore */ }
  }
});

document.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  moved += Math.abs(event.movementX || 0) + Math.abs(event.movementY || 0);

  // one follow per frame: dragging a transparent window is expensive, and the
  // main process is about to ask the OS for the cursor anyway
  pending = true;
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    if (!pending) return;
    pending = false;
    call(api.launcherFollow());
  });
});

document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

function endDrag(event) {
  if (!dragging) return;
  dragging = false;
  pending = false;
  document.body.classList.remove('dragging');
  call(api.launcherDragEnd());
  call(api.launcherClamp());

  // A press that barely moved is a click, and a click means "come back". Pointer
  // events always carry `button`; it is absent only on synthesized ones, which
  // are treated as primary so scripted clicks still work.
  const isPrimary = typeof event.button === 'number' ? event.button === 0 : true;
  if (moved < 6 && isPrimary) call(api.showPet());
}

/** Every bridge call is fire-and-forget; a rejected frame must never surface. */
function call(result) {
  try {
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    /* ignore */
  }
}

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  call(api.launcherMenu());
});

// Click-through arming is driven entirely by the main process's cursor watch.
// There used to be `pointerenter`/`pointerleave` listeners here as well, but they
// arm on the whole *window* rectangle while the hit test works on the circle, so
// entering the window over a corner armed it and nothing disarmed it again — the
// exact "invisible click eater" this feature exists to remove.
api.onHitTest((point) => { setInteractive(hitsMedalAt(point.x, point.y)); });

// ------------------------------------------------------------------- startup --
function toBlobUrl(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
}

async function loadFace() {
  try {
    const payload = await api.frames();
    const map = (payload && payload.frames) || payload || {};
    const base64 = map.mini;
    if (!base64) return;
    const url = toBlobUrl(base64.includes(',') ? base64.split(',')[1] : base64);
    if (faceUrl) URL.revokeObjectURL(faceUrl);
    faceUrl = url;
    face.src = url;
  } catch {
    /* the medallion still works without the face */
  }
}

api.onState(render);
loadFace();
api.getState().then(render).catch(() => {});
// No polling timer here: the window process pushes a fresh snapshot to both
// windows every few seconds, and a second copy of the medallion is never on
// screen to need one.

window.addEventListener('unload', () => {
  if (hintTimer) clearTimeout(hintTimer);
  if (faceUrl) URL.revokeObjectURL(faceUrl);
});
