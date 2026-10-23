'use strict';

/**
 * Pet renderer.
 *
 * Three expressions drive the look: the resting face (`base`), the chewing face
 * (`chew`) used while the agent is working, and the grin (`hover`) under the
 * cursor. Body and topknot are the same art on two clipped layers so the ahoge
 * can sway independently, and a click plays a squash-and-stretch.
 *
 * Dragging moves the window through the bridge; because the bubble lives in the
 * same window and is positioned in window coordinates, it cannot drift away from
 * the character.
 */

const api = window.dsh;

const pet = document.getElementById('pet');
const bubble = document.getElementById('bubble');
const bubbleTitle = document.getElementById('bubbleTitle');
const badge = document.getElementById('badge');
const sessionTokens = document.getElementById('sessionTokens');
const allTimeTokens = document.getElementById('allTimeTokens');
const balanceValue = document.getElementById('balance');
const ctxBar = document.getElementById('ctxBar');
const ctxFill = document.getElementById('ctxFill');

const LOW_BALANCE = 10;   // CNY

// frames arrive as base64 and become blob urls: a fresh key every load, so
// regenerated art can never be masked by a reused decode-cache entry.
//
// Only the full-body drawings are listed. The pack's `idle` / `busy` / `alert`
// are 256x256 avatar crops — the `mini` family — and drawing one into the mascot
// slot fills the window with a floating head (two of them carry a "Deepseek"
// banner). They are deliberately not fetched, so a future edit cannot reach for
// them by filename alone. See FACE_OF below and docs/pet-v2-design.md §13.
const FRAMES = { base: null, chew: null, hover: null };
const IMAGES = {
  bodyBase: document.getElementById('bodyBase'),
  bodyChew: document.getElementById('bodyChew'),
  knotBase: document.getElementById('knotBase'),
  knotChew: document.getElementById('knotChew'),
};

let currentFace = null;
let hovered = false;
let lastState = null;
let chewing = false;
let chewTimer = null;
// identity of the newest in-flight swap per layer, so an older one can bow out
const PENDING = {};

/** Which art a state draws with. Mirrors FACE_OF in lib/pet-state.js. */
const FACE_OF = {
  idle: 'base',
  thinking: 'base',
  working: 'chew',
  celebrate: 'hover',
  error: 'base',
  sleep: 'base',
};

/**
 * The face to draw.
 *
 * The cursor always wins: hovering is a direct answer to the user's own hand and
 * should never be delayed by whatever the agent happens to be doing. Underneath
 * that, the host's state is the answer; a window that has not heard from the
 * host (or an older one that only sends `busy`) falls back to the two states the
 * window can still justify on its own.
 */
function faceFor(state) {
  if (hovered) return 'hover';
  const tokens = (state && state.tokens) || {};
  const named = tokens.state && FACE_OF[tokens.state];
  if (named) return named;
  return tokens.busy ? 'chew' : 'idle';
}

/** Swaps the drawn expression. New elements are used per change so a stale
 *  decode can never keep painting the previous face. */
function swapImage(key, url) {
  const current = IMAGES[key];
  if (!current || !url) return;
  const next = current.cloneNode(false);
  next.removeAttribute('src');

  // A second swap can begin while this one is still decoding — hovering in and
  // straight back out does it. Hand every swap an identity so the superseded one
  // stands down, and only ever publish a node that actually reached the document:
  // the previous version wrote IMAGES[key] from the *stale* captured node, so a
  // swap that lost the race left the slot pointing at a detached element, after
  // which replaceChild silently no-opped and the face could never change again.
  const token = {};
  PENDING[key] = token;
  next.addEventListener('load', () => {
    if (PENDING[key] !== token) return;      // a newer swap already won
    const live = IMAGES[key];                // read fresh: it may have moved on
    if (live && live.parentNode) live.parentNode.replaceChild(next, live);
    IMAGES[key] = next;
  }, { once: true });

  next.src = url;
}

function setFace(face) {
  if (!FRAMES[face] || face === currentFace) return;
  currentFace = face;
  const url = FRAMES[face];
  swapImage('bodyBase', url);
  swapImage('knotBase', url);
  // the chewing mouth always comes from the `chew` art, whatever the base face is
  swapImage('bodyChew', FRAMES.chew);
  swapImage('knotChew', FRAMES.chew);
}

/** Chewing is a mouth swap at a steady rhythm while the agent is working. */
function setChewing(on) {
  if (on === chewing) return;
  chewing = on;
  if (chewTimer) {
    clearInterval(chewTimer);
    chewTimer = null;
  }
  if (!on) {
    pet.dataset.chew = 'off';
    return;
  }
  pet.dataset.chew = 'on';
  chewTimer = setInterval(() => {
    pet.dataset.chew = pet.dataset.chew === 'on' ? 'off' : 'on';
  }, 240);
}

/**
 * 立绘状态去抖 —— 修「表情抽搐」。
 *
 * 抽搐的根因：一个回合里 `step/start`（thinking）和 `tool/call`（working）
 * 会几百毫秒交替一次。每次交替都要换图 + 关开咀嚼计时器，眼睛看到的就是在抽。
 * （宿主侧不发这一帧也没用：状态机本来就该逐事件变化，抖动是渲染层的问题。）
 *
 * 规则：thinking/working 这类短暂状态必须稳定超过 STATE_SETTLE_MS 才落到 DOM；
 * celebrate / error / sleep 立刻生效 —— 它们自带时长语义，不能被拖慢。
 */
const STATE_SETTLE_MS = 400;
let shownState = 'idle';
let stateTimer = null;

/** 把 shownState + hover 落到 DOM 上（可重复调用，幂等）。 */
function applyPose() {
  pet.dataset.state = hovered && shownState !== 'working' ? 'hover' : shownState;
  setChewing(shownState === 'working');
}

function scheduleState(next) {
  if (next === shownState) return;
  if (next === 'celebrate' || next === 'error' || next === 'sleep') {
    if (stateTimer !== null) {
      clearTimeout(stateTimer);
      stateTimer = null;
    }
    shownState = next;
    applyPose();
    return;
  }
  if (stateTimer !== null) clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    stateTimer = null;
    shownState = next;
    applyPose();
  }, STATE_SETTLE_MS);
}

/**
 * The bubble's headline for a state.
 *
 * A pet that says "正在干活…" for every kind of work is barely more informative
 * than a progress bar. The state machine already knows which of six things is
 * happening, so say it — and when the host has told us which tool is running,
 * name that too, because "编辑" and "跑测试" are very different kinds of waiting.
 */
function titleFor(machineState, tokens) {
  const tool = tokens.tool && tokens.tool.name ? String(tokens.tool.name) : '';
  switch (machineState) {
    case 'thinking':
      return '在想…';
    case 'working':
      return tool ? `正在用 ${tool}` : '正在干活…';
    case 'celebrate':
      return '搞定！';
    case 'error':
      return '出错了…';
    case 'sleep':
      return '睡着中…';
    default:
      // Resting: the session title is the most useful thing left to show.
      return tokens.title || '在想事情…';
  }
}

function render(state) {
  if (!state) return;
  lastState = state;

  const { tokens, balance, compact } = state;
  const busy = Boolean(tokens.busy);
  // The host names the state; a window that has not heard from it (or an older
  // host that only sends `busy`) degrades to the two states it can justify.
  const machineState = tokens.state || (busy ? 'working' : 'idle');
  const lowMoney = balance && balance.ok && Number.isFinite(balance.total) && balance.total < LOW_BALANCE;
  const moneyBroken = balance && !balance.ok;

  const face = faceFor(state);
  setFace(face);
  // 立绘/咀嚼走 scheduleState（去抖）；文字类信息立刻更新。
  scheduleState(machineState);
  applyPose();
  badge.hidden = !busy;

  document.body.classList.toggle('show-bubble', hovered || busy);
  // The bubble is also where the pet narrates what it is doing, so the states
  // that need to say something keep it up on their own.
  document.body.classList.toggle('show-progress', machineState === 'working' || machineState === 'thinking');

  bubbleTitle.textContent = titleFor(machineState, tokens);
  sessionTokens.textContent = `${compact.tokens} tokens`;
  sessionTokens.title = `输入 ${tokens.input} · 输出 ${tokens.output} · 缓存读 ${tokens.cacheRead}`;
  allTimeTokens.textContent = `${compact.allTime} · ${tokens.sessions} 会话`;

  if (balance && balance.ok) {
    balanceValue.textContent = compact.balance;
    balanceValue.className = `v ${lowMoney ? 'warn' : 'good'}`;
    balanceValue.title = `充值 ${balance.toppedUp?.toFixed(2)} · 赠送 ${balance.granted?.toFixed(2)}`;
  } else if (moneyBroken) {
    balanceValue.textContent = '—';
    balanceValue.className = 'v bad';
    balanceValue.title = balance.error || '余额未知';
  }

  if (compact.contextPercent != null) {
    const percent = Math.min(100, Math.max(0, compact.contextPercent));
    ctxBar.hidden = false;
    ctxFill.style.width = `${percent}%`;
    ctxFill.className = percent > 85 ? 'bad' : percent > 65 ? 'warn' : '';
    ctxBar.title = `上下文占用 ${percent}%`;
  } else {
    ctxBar.hidden = true;
  }
}

// ----------------------------------------------------------------- hit mask ---
/**
 * Which pixels of the window are actually the character.
 *
 * The window is a 330x440 rectangle of mostly nothing: the mascot covers a
 * fraction of it, and a transparent-but-mouse-enabled window silently eats every
 * click in the rest. The main process spawns the window click-through and this
 * is what decides when to take the mouse back.
 *
 * The mask is derived from the art that is already loaded — no second asset to
 * keep in sync with the drawings. It is downsampled (every `MASK_STEP` pixels)
 * because the answer only needs to be right at the edges of a cartoon, and an
 * alpha threshold keeps soft anti-aliased fringes from counting as solid.
 */
const MASK_STEP = 4;
const MASK_ALPHA = 24;
/** How far outside the artwork still counts as a hit, in CSS pixels. */
const MASK_GROW = 8;

let mask = null;          // { w, h, cells: Uint8Array } in art pixel space
let maskKey = null;
let armed = null;         // last interactivity state we told the main process

/** Builds the hit mask from a decoded art frame. */
function buildMask(url) {
  const img = new Image();
  img.onload = () => {
    const w = Math.max(1, Math.ceil(img.naturalWidth / MASK_STEP));
    const h = Math.max(1, Math.ceil(img.naturalHeight / MASK_STEP));
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const gfx = canvas.getContext('2d', { willReadFrequently: true });
    gfx.drawImage(img, 0, 0);
    let data;
    try {
      data = gfx.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch {
      return;   // tainted canvas cannot happen for blob urls, but never break the pet
    }
    const cells = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        // Any opaque pixel inside the cell makes the whole cell solid.
        let solid = 0;
        for (let sy = 0; sy < MASK_STEP && !solid; sy += 1) {
          for (let sx = 0; sx < MASK_STEP; sx += 1) {
            const px = x * MASK_STEP + sx;
            const py = y * MASK_STEP + sy;
            if (px >= canvas.width || py >= canvas.height) break;
            if (data[(py * canvas.width + px) * 4 + 3] >= MASK_ALPHA) { solid = 1; break; }
          }
        }
        cells[y * w + x] = solid;
      }
    }
    mask = { w, h, cells };
    maskKey = url;
  };
  img.src = url;
}

/**
 * Is the cursor over the character?
 *
 * The point arrives as window-relative CSS pixels. It used to come from a
 * `pointermove` event, but a window that is ignoring the mouse receives no
 * pointer events at all on Windows — measured: zero `pointermove` while
 * click-through was on, eight with it off, over the same cursor sweep. `forward:
 * true` does not rescue that here. So the main process polls the OS cursor and
 * asks this question over IPC; the renderer owns the answer because it owns the
 * art.
 */
function hitsPetAt(px, py) {
  if (!mask) return true;   // no mask yet: behave like the old whole-window pet
  const box = pet.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return true;
  const scale = Math.min(box.width / (mask.w * MASK_STEP), box.height / (mask.h * MASK_STEP));
  const drawW = mask.w * MASK_STEP * scale;
  const drawH = mask.h * MASK_STEP * scale;
  // object-position: center bottom
  const left = box.left + (box.width - drawW) / 2;
  const top = box.top + (box.height - drawH);
  const x = (px - left) / scale;
  const y = (py - top) / scale;
  const cx = Math.floor(x / MASK_STEP);
  const cy = Math.floor(y / MASK_STEP);
  // A little grace around the artwork: grabbing a cartoon character by its exact
  // silhouette is fussy, and being one cell generous costs a few transparent
  // pixels of click-through rather than a click that seems to do nothing.
  const span = Math.max(1, Math.ceil(MASK_GROW / (MASK_STEP * scale)));
  for (let gy = cy - span; gy <= cy + span; gy += 1) {
    for (let gx = cx - span; gx <= cx + span; gx += 1) {
      if (gx < 0 || gy < 0 || gx >= mask.w || gy >= mask.h) continue;
      if (mask.cells[gy * mask.w + gx]) return true;
    }
  }
  return false;
}

/** Tells the main process whether the window should accept the mouse right now. */
function setInteractive(on) {
  if (on === armed) return;
  armed = on;
  try {
    const result = api.setInteractive(on);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch { /* the bridge is optional */ }
}

// Diagnostics for the click-through path. Off unless asked for, because a pet
// that logs on every mouse move is a pet that heats the room: enable with
// DSH_PET_DEBUG=1 in the window's environment.
const DEBUG_HIT = (() => {
  try { return location.search.includes('debughit'); } catch { return false; }
})();
function traceHit(point, hit) {
  if (!DEBUG_HIT) return;
  try {
    console.log(`hit ${hit ? 'ON ' : 'off'} at=(${Math.round(point.x)},${Math.round(point.y)}) mask=${mask ? `${mask.w}x${mask.h}` : 'none'}`);
  } catch { /* ignore */ }
}

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
  // tell the main process a drag started: it notes where in the window the
  // cursor grabbed the pet, and afterwards follows the cursor itself
  try { const r = api.dragBegin(); if (r && r.catch) r.catch(() => {}); } catch { /* ignore */ }
  // keep receiving moves even when the cursor leaves this small window
  if (document.body.setPointerCapture) {
    try { document.body.setPointerCapture(event.pointerId); } catch { /* ignore */ }
  }
});

// Arming is driven by the main process, not by pointer events: a window that is
// ignoring the mouse receives none (see hitsPetAt above). Main polls the OS
// cursor and tells the renderer where it is; the renderer answers by flipping
// the window's interactivity itself, so no reply has to travel back.
api.onHitTest((point) => {
  const hit = hitsPetAt(point.x, point.y);
  traceHit(point, hit);
  setInteractive(hit);
});

document.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  moved += Math.abs(event.movementX || 0) + Math.abs(event.movementY || 0);

  // Move on the next frame at most: dragging a transparent window is expensive,
  // and the compositor needs the chance to keep the bubble in step with the art.
  //
  // The renderer sends no coordinates. It reports cursor positions in CSS
  // pixels, which page zoom and display scaling both redefine, while the window
  // is placed in device-independent pixels — so the main process reads the
  // cursor from the OS and puts the grabbed point back under it.
  pending = true;
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    if (!pending) return;
    pending = false;
    try {
      // A failed frame must never escape as an unhandled rejection: that killed
      // the whole renderer once, which made the window refuse to open at all.
      const result = api.follow();
      if (result && typeof result.catch === 'function') result.catch(reportDragError);
    } catch (error) {
      reportDragError(error);
    }
  });
});

let dragErrorReported = false;
function reportDragError(error) {
  if (dragErrorReported) return;
  dragErrorReported = true;
  try { console.error('pet drag failed:', (error && error.message) || String(error)); } catch { /* ignore */ }
}

function endDrag(event) {
  if (!dragging) return;
  dragging = false;
  pending = false;
  document.body.classList.remove('dragging');
  try { const r = api.dragEnd(); if (r && r.catch) r.catch(() => {}); } catch { /* ignore */ }
  // snap back into the work area now that the gesture is over
  try {
    const result = api.clamp();
    if (result && typeof result.catch === 'function') result.catch(reportDragError);
  } catch (error) {
    reportDragError(error);
  }
  // Only a primary-button press that barely moved counts as a click. Pointer
  // events always carry `button`; it is absent only on synthesized ones, which
  // are treated as primary so scripted drags still click.
  const isPrimary = typeof event.button === 'number' ? event.button === 0 : true;
  if (moved < 6 && isPrimary) {
    // A click pats the pet — nothing else. It used to also snap the window to
    // the corner, which threw away a position the user had just dragged it to;
    // "显示在右下角" is still in the right-click menu for when that is wanted.
    squash();
  }
}

document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

function squash() {
  pet.dataset.squash = 'off';
  // restart the animation reliably
  void pet.offsetWidth;
  pet.dataset.squash = 'on';
  setTimeout(() => { pet.dataset.squash = 'off'; }, 460);
}

document.addEventListener('dblclick', () => api.showWindow());
document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  api.menu();
});

document.addEventListener('pointerenter', () => {
  hovered = true;
  if (lastState) render(lastState);
});
document.addEventListener('pointerleave', () => {
  hovered = false;
  if (lastState) render(lastState);
});

// ------------------------------------------------------------------- startup --
function toBlobUrl(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
}

async function loadFrames() {
  try {
    const payload = await api.frames();
    const map = (payload && payload.frames) || payload || {};
    for (const name of Object.keys(FRAMES)) {
      const base64 = map[name];
      if (!base64) continue;
      const url = toBlobUrl(base64.includes(',') ? base64.split(',')[1] : base64);
      if (FRAMES[name]) URL.revokeObjectURL(FRAMES[name]);
      FRAMES[name] = url;
    }
    currentFace = null;   // force a redraw with the fresh art
    // The hit mask must come from the art that is actually drawn. `base` is the
    // resting full-body drawing and every other expression shares its silhouette,
    // so one mask covers them all — but it has to be *that* family: `idle` is a
    // 256x256 avatar crop and would test the wrong rectangle entirely.
    const maskUrl = FRAMES.base;
    if (maskUrl && maskUrl !== maskKey) buildMask(maskUrl);
  } catch {
    /* the panel still renders without art */
  }
  if (lastState) render(lastState);
}

api.onState(render);
loadFrames();
api.getState().then(render).catch(() => {});
setInterval(() => api.refresh().then(render).catch(() => {}), 15000);
setInterval(() => loadFrames().catch(() => {}), 60000);
