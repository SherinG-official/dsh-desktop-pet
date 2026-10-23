'use strict';

/**
 * The desktop pet, as its own Electron application.
 *
 * It was a window inside the main app, which meant every CSS tweak cost a full
 * app restart — and that took the shared engine down with it. Running it as a
 * separate process makes the pet independently restartable, and lets it read
 * everything it shows straight from disk and the public balance endpoint, so it
 * needs nothing from the main app:
 *
 *   token usage -> <dsh home>/storages/session_projcache  (via ./metrics)
 *   balance     -> GET https://api.deepseek.com/user/balance (via ./balance)
 *   art         -> assets/pet/*.png, pushed to the renderer as blob urls
 *
 * It owns two windows: the mascot, and a small medallion that stands in for it
 * while it is hidden. Exactly one of them is on screen at a time; the medallion
 * exists because hiding the pet used to be a one-way door — the desktop shell
 * has no "show the pet" switch, so nothing could bring it back.
 *
 * It is a single process with no tray and no menus of its own. The only thing it
 * needs from outside is "show the main window", which it asks for by connecting
 * to a loopback focus port (see focus-port.js).
 *
 * Three ways to start it, all reaching run() below:
 *   npm run pet                       a dev checkout
 *   electron pet-app --pet --dev      the thin shim in pet-app/
 *   "DSH Desktop.exe" --pet           the installed app, re-launched as the pet
 */

const { app, BrowserWindow, Menu, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { Metrics } = require('./metrics');
const { Balance } = require('./balance');
const util = require('./util');
const { FOCUS_PORT, PET_CONTROL_PORT } = require('./focus-port');
const { SCALES, normalizeScale } = require('./scales');

const ROOT = path.join(__dirname, '..');

/**
 * Each window draws into a fixed logical canvas and the window is scaled to fit.
 *
 * Scaling the window alone would only crop the art, and rewriting every offset
 * in the layout for each size would put the bubble and the badge out of step the
 * first time someone forgot one. `setZoomFactor` scales the whole renderer —
 * art, text, borders, hit testing — so the canvas stays 330x440 (and the
 * medallion 148x176) at every setting and only the physical size changes.
 */
const PET_BASE = { width: 330, height: 440 };
const LAUNCHER_BASE = { width: 148, height: 176 };

const STATE_FILE = path.join(util.dshHome(), 'desktop', 'pet-window.json');

/** How often the cursor is sampled to decide whether the pet is under it. */
const CURSOR_WATCH_MS = 60;

let metrics;
let balance;
let petWindow = null;
let launcherWindow = null;
let controlServer = null;

/** Current zoom, shared by both windows. */
let scale = 1;

/**
 * Whether the transparent parts of a window let clicks through to the desktop.
 *
 * On by default: the alternative is an invisible rectangle that eats clicks. It
 * is a setting because click-through costs one thing — you cannot start a drag
 * from a transparent pixel — so someone who prefers a forgiving grab area can
 * turn it off and get the old whole-window behaviour.
 */
let clickThrough = true;

/** Debug the hit test (payload in the log, renderer console forwarded). */
const DEBUG_HIT = process.env.DSH_PET_DEBUG_HIT === '1';

/**
 * Where inside each window the cursor grabbed it, in screen coordinates.
 *
 * The drag is driven from the *cursor*, not from the coordinates the renderer
 * reports. `event.screenX` and `window.screenX` are in CSS pixels — which page
 * zoom and display scaling both redefine — while `setBounds` wants screen
 * device-independent pixels. Asking the OS for the cursor position keeps both
 * sides in the one coordinate space the main process controls, so dragging stays
 * exact at 75% and at 150% alike.
 */
let petGrab = null;
let launcherGrab = null;

function readState() {
  return util.readJsonSafe(STATE_FILE) || {};
}

function writeState(patch) {
  try {
    const next = { ...readState(), ...patch };
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  } catch {
    /* window state is a convenience, never fatal */
  }
}

// --------------------------------------------------------------------- scale ---
/** Saved choice wins, then the plugin's configured default, then 100%. */
function resolveInitialScale() {
  return normalizeScale(readState().scale)
    || normalizeScale(process.env.DSH_PET_SCALE)
    || 1;
}

function scaled(base) {
  return { width: Math.round(base.width * scale), height: Math.round(base.height * scale) };
}

function petSize() { return scaled(PET_BASE); }
function launcherSize() { return scaled(LAUNCHER_BASE); }

/**
 * Fixes a window's size for good.
 *
 * Both windows are pinned to min == max == their current size: nothing on the
 * desktop may resize them (Windows' snap handling grabs a frameless window by
 * its edges), and every later `setBounds` is expected to move only. A size
 * change therefore has to re-pin *before* moving, which is exactly what
 * setScale() does — setting the pin to the new size first means the following
 * setBounds is not clamped back to the old one.
 */
function pinSize(win, size) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setMinimumSize(size.width, size.height);
    win.setMaximumSize(size.width, size.height);
  } catch { /* ignore */ }
}

function applyZoom(win) {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.setZoomFactor(scale); } catch { /* not loaded yet */ }
}

/**
 * Makes a window click-through unless the renderer has armed interactivity.
 *
 * A transparent, frameless, always-on-top window is a *mouse-enabled* rectangle
 * by default: the art covers a fraction of it and the rest silently swallows
 * clicks meant for whatever is underneath. That is the "dead zone" every desktop
 * pet hits, and the fix is to start click-through and let the renderer turn
 * interactivity back on only over solid pixels.
 *
 * `forward: true` is what makes that possible: it keeps `mousemove` flowing to
 * the page even while the window is ignoring the mouse, so the renderer can
 * notice the cursor arriving on the character and arm itself. Without it the
 * window would never hear the cursor again and could not be clicked at all.
 *
 * Called on creation *and* after every move: an un-ignored window left behind by
 * a snap or a re-home is the same bug class as an un-ignored window at startup.
 */
function applyClickThrough(win) {
  if (!win || win.isDestroyed()) return;
  if (!clickThrough) {
    try { win.setIgnoreMouseEvents(false); } catch { /* ignore */ }
    return;
  }
  try { win.setIgnoreMouseEvents(true, { forward: true }); } catch { /* older electron */ }
}

/**
 * The renderer asks for the mouse back when the cursor is over the character,
 * and gives it up again when it leaves. This is the only writer of that state
 * besides applyClickThrough().
 */
function setInteractive(which, on) {
  const win = windowOf(which);
  if (!win || win.isDestroyed()) return false;
  if (!clickThrough) return true;   // the whole window is always live
  try {
    win.setIgnoreMouseEvents(!on, { forward: true });
  } catch {
    return false;
  }
  return true;
}

/**
 * Watches the cursor and tells each window whether it is over the character.
 *
 * This has to live in the main process. A window that is ignoring the mouse is
 * sent no pointer events at all on Windows — measured on this machine: zero
 * `pointermove` while click-through was on and eight with it off, over the same
 * cursor sweep — so the renderer can never notice the cursor arriving and could
 * never re-arm itself. `forward: true` does not change that here.
 *
 * The OS cursor position is available to the main process regardless, so the
 * poll asks the renderer (which owns the art and therefore the hit test) where
 * the cursor is, and the renderer flips the flag. Polling rather than listening
 * because there is no event to listen to; 60 ms is fast enough that a click
 * lands on the frame it was aimed at, and it is one syscall plus one tiny IPC
 * message when the answer has not changed.
 */
function startCursorWatch() {
  // Per window: one shared flag would let the pet's state clobber the
  // medallion's, and the two are rarely in the same place.
  const outside = { pet: null, launcher: null };
  const watch = setInterval(() => {
    for (const which of ['pet', 'launcher']) {
      const win = windowOf(which);
      if (!win || win.isDestroyed() || !win.isVisible()) continue;
      let point;
      try {
        point = screen.getCursorScreenPoint();
      } catch {
        continue;
      }
      const bounds = win.getBounds();
      // Off this window entirely: nobody needs the hit test, and telling the
      // window so is what hands the desktop its clicks back.
      const inside = point.x >= bounds.x && point.x < bounds.x + bounds.width
        && point.y >= bounds.y && point.y < bounds.y + bounds.height;
      if (!inside) {
        if (outside[which] !== true) {
          outside[which] = true;
          setInteractive(which, false);
          // 光标离开整个窗口：也要告诉渲染层一声，否则 hover 会卡在最后
          // 一次命中上（笑一直挂着）。用 (-1,-1) 当"外面"的哨兵。
          try {
            win.webContents.send('pet:hit-test', { x: -1, y: -1 });
          } catch { /* the renderer is not listening yet */ }
        }
        continue;
      }
      outside[which] = false;
      // Window-relative CSS pixels: the renderer's own coordinate space.
      try {
        win.webContents.send('pet:hit-test', {
          x: point.x - bounds.x,
          y: point.y - bounds.y,
        });
      } catch { /* the renderer is not listening yet */ }
    }
  }, CURSOR_WATCH_MS);
  if (typeof watch.unref === 'function') watch.unref();
  return watch;
}

/**
 * Changes the zoom, keeping each window's bottom edge and horizontal centre
 * where they were — the mascot stands on the desktop, so its feet should not
 * jump when it grows.
 */
function setScale(value) {
  const next = normalizeScale(value);
  if (!next || next === scale) return false;
  scale = next;
  writeState({ scale });

  for (const [win, size, key] of [
    [petWindow, petSize(), 'bounds'],
    [launcherWindow, launcherSize(), 'launcherBounds'],
  ]) {
    if (!win || win.isDestroyed()) continue;
    const bounds = win.getBounds();
    const target = {
      x: Math.round(bounds.x + bounds.width / 2 - size.width / 2),
      y: Math.round(bounds.y + bounds.height - size.height),
      width: size.width,
      height: size.height,
    };
    pinSize(win, size);
    repositionWindow(win, target);
    writeState({ [key]: win.getBounds() });
    applyZoom(win);
  }

  push();
  raiseWindows();
  return true;
}

// --------------------------------------------------------------------- state ---
/**
 * What the host plugin last told us about the agent, and when.
 *
 * The window cannot work this out on its own. Token metrics come from DSH's
 * projection cache, and that cache is written at *step boundaries* — measured
 * 5–11 s apart on a working turn, with stretches over 40 s during one long model
 * call — so a freshness test on it reports "idle" through most of the time the
 * agent is actually busy. The host plugin subscribes to the engine's own
 * `agent/status` (the same source the harness UI's spinner uses) and pushes the
 * verdict down the control port; this is where it lands.
 *
 * The host re-states the flag every 15 s, so a value that has gone quiet for
 * longer than the TTL means the host is gone — plugin unloaded, desktop app
 * closed — and the file heuristic takes over again. Without that, an unloaded
 * plugin would leave the pet chewing forever.
 */
const HOST_BUSY_TTL_MS = 45_000;
let hostBusy = false;
let hostBusyAt = 0;

/**
 * The last full state frame the host sent, or null.
 *
 * 0.3.1 only ever learned a boolean. Now the host describes *what* the agent is
 * doing — which of six states, which tool, how far into the turn — and the pet
 * draws that directly. Kept verbatim rather than reinterpreted: the host owns
 * the state machine (lib/pet-state.js) so that the rules live in one place and
 * can be tested without a window.
 */
let hostState = null;
let hostStateAt = 0;

/** True while the agent works: the host's verdict while it is talking, the file heuristic otherwise. */
function busyNow() {
  if (hostBusyAt > 0 && Date.now() - hostBusyAt < HOST_BUSY_TTL_MS) return hostBusy;
  return metrics.isBusy();
}

/**
 * The state to draw, as one word.
 *
 * While the host is talking this is simply its answer. Once it has gone quiet
 * (plugin unloaded, desktop app closed) the pet falls back to the one thing it
 * can still observe for itself — whether the projection cache is moving — and so
 * can only be idle or working: it cannot tell a finished turn from an aborted
 * one by looking at a file's mtime, and it must not pretend to.
 */
function stateNow() {
  const fresh = hostStateAt > 0 && Date.now() - hostStateAt < HOST_BUSY_TTL_MS;
  if (fresh && hostState) return hostState.state;
  return busyNow() ? 'working' : 'idle';
}

/**
 * Records the host's verdict. Returns true when the *effective* flag moved.
 *
 * The comparison is against `busyNow()`, not against the stored host value:
 * while the host was quiet the file heuristic was speaking for the pet, so the
 * first message from the host usually contradicts it — and a `busy:0` that
 * happens to match a stale `hostBusy` still has to take the chewing away now
 * rather than on the next 5 s poll.
 */
function setHostBusy(on) {
  const before = busyNow();
  hostBusy = on;
  hostBusyAt = Date.now();
  return before !== busyNow();
}

/**
 * Parses one `state:{...}` frame from the host.
 *
 * Returns false when the payload is not usable, and the caller answers with a
 * refusal rather than pretending it applied. A malformed frame must never take
 * the control server down: this runs inside a socket callback, and an exception
 * there would kill the connection (or worse) while the pet keeps running with a
 * stale face.
 */
function noteHostState(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.state !== 'string') return false;
  hostState = parsed;
  hostStateAt = Date.now();
  // The state frame carries the busy flag too, so keep the older command's
  // bookkeeping in step: a window that gets both must not oscillate.
  hostBusy = Boolean(parsed.busy);
  hostBusyAt = hostStateAt;
  return true;
}

function snapshot() {
  const tokens = metrics.state;
  const money = balance.state;
  return {
    scale,
    tokens: {
      session: tokens.liveSession,
      title: tokens.liveTitle,
      totalTokens: tokens.totalTokens,
      input: tokens.totals.uncachedInputTokens,
      output: tokens.totals.outputTokens,
      cacheRead: tokens.totals.cacheReadTokens,
      cacheWrite: tokens.totals.cacheWriteTokens,
      allTimeTokens: tokens.allTimeTokens,
      sessions: tokens.sessions,
      turns: tokens.turns,
      steps: tokens.steps,
      context: tokens.context,
      busy: busyNow(),
      // What the mascot is doing, and the one detail worth showing: the host
      // decides both (see stateNow()).
      state: stateNow(),
      tool: hostState && hostStateAt > 0 && Date.now() - hostStateAt < HOST_BUSY_TTL_MS
        ? hostState.tool
        : null,
      step: hostState ? hostState.step : null,
    },
    balance: money,
    compact: {
      tokens: util.compact(tokens.totalTokens),
      allTime: util.compact(tokens.allTimeTokens),
      balance: balance.display,
      contextPercent: tokens.context && tokens.context.contextWindow
        ? Math.round((tokens.context.pressureTokens / tokens.context.contextWindow) * 100)
        : null,
    },
  };
}

function push() {
  const state = snapshot();
  for (const win of [petWindow, launcherWindow]) {
    if (!win || win.isDestroyed()) continue;
    try { win.webContents.send('state:update', state); } catch { /* not listening yet */ }
  }
  const title = `DSH 桌宠 · ${state.compact.tokens} tokens · ${state.compact.balance}`;
  if (petWindow && !petWindow.isDestroyed()) petWindow.setTitle(title);
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    const percent = state.compact.contextPercent;
    launcherWindow.setTitle(`DSH 桌宠 · 上下文 ${percent == null ? '—' : `${percent}%`} · ${state.compact.balance}`);
  }
  return state;
}

// -------------------------------------------------------------------- layout ---
function areaOfPoint(x, y) {
  const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) })
    || screen.getPrimaryDisplay();
  return display.workArea;
}

/** The work area a remembered rectangle still belongs to, or null when it is gone. */
function areaContaining(bounds) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return null;
  const width = Number.isFinite(bounds.width) ? bounds.width : 0;
  const height = Number.isFinite(bounds.height) ? bounds.height : 0;
  const centre = { x: Math.round(bounds.x + width / 2), y: Math.round(bounds.y + height / 2) };
  const area = areaOfPoint(centre.x, centre.y);
  if (centre.x < area.x || centre.x >= area.x + area.width) return null;
  if (centre.y < area.y || centre.y >= area.y + area.height) return null;
  return { area, width, height };
}

function clampToArea(rect, area) {
  return {
    x: Math.round(Math.min(Math.max(rect.x, area.x), area.x + area.width - rect.width)),
    y: Math.round(Math.min(Math.max(rect.y, area.y), area.y + area.height - rect.height)),
  };
}

/**
 * Where the pet should open.
 *
 * A saved position is only reused when its centre still lands on a monitor that
 * currently exists. Display layouts change — a laptop undocked, a resolution
 * switched — and a remembered spot can end up in the dead space beyond every
 * screen, where the window is technically shown and completely unseeable.
 */
function resolveStartPosition() {
  const size = petSize();
  const saved = readState().bounds;
  const fit = areaContaining(saved);
  if (fit && fit.width >= size.width - 8 && fit.height >= size.height - 8) {
    return { x: Math.round(saved.x), y: Math.round(saved.y) };
  }
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - size.width - 16,
    y: area.y + area.height - size.height - 16,
  };
}

/**
 * Where the medallion should open.
 *
 * It takes over the spot the mascot last stood on, so hiding looks like the
 * character shrank rather than teleported. A position the user dragged it to is
 * preferred over that; both are dropped in favour of the primary display's
 * corner when the remembered spot is on a monitor that no longer exists.
 */
function resolveLauncherPosition() {
  const size = launcherSize();
  const state = readState();

  const savedFit = areaContaining(state.launcherBounds);
  if (savedFit && savedFit.width >= size.width - 8 && savedFit.height >= size.height - 8) {
    return { x: Math.round(state.launcherBounds.x), y: Math.round(state.launcherBounds.y) };
  }

  const petFit = areaContaining(state.bounds);
  if (petFit && petFit.width >= 8 && petFit.height >= 8) {
    return clampToArea({
      x: state.bounds.x + petFit.width / 2 - size.width / 2,
      y: state.bounds.y + petFit.height - size.height,
      width: size.width,
      height: size.height,
    }, petFit.area);
  }

  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - size.width - 16,
    y: area.y + area.height - size.height - 16,
  };
}

// -------------------------------------------------------------------- window ---
function createPetWindow() {
  const size = petSize();
  const { x, y } = resolveStartPosition();

  petWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    title: 'DSH 桌宠',
    webPreferences: {
      preload: path.join(__dirname, 'pet-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // highest z-order level plus periodic raising: another topmost window (a
  // maximised player, say) otherwise sits above the pet and eats its clicks
  try { petWindow.setAlwaysOnTop(true, 'screen-saver'); } catch { /* older electron */ }
  pinSize(petWindow, size);
  applyZoom(petWindow);
  // Before it is ever shown: a window that is mouse-enabled even for a moment is
  // a window that can eat a click.
  applyClickThrough(petWindow);

  petWindow.loadFile(path.join(ROOT, 'renderer', 'pet.html'), DEBUG_HIT
    ? { query: { debughit: '1' } }
    : undefined);
  // The renderer's console is otherwise invisible: it goes to a devtools window
  // nobody opened. Forward it when the hit test is being debugged.
  if (DEBUG_HIT) {
    petWindow.webContents.on('console-message', (_event, _level, message) => {
      try { console.log(`[renderer] ${message}`); } catch { /* ignore */ }
    });
    // Proof that the forwarding path itself works, independent of the hit test.
    console.log('[main] hit-test debugging enabled');
  }
  petWindow.webContents.on('did-finish-load', () => {
    applyZoom(petWindow);
    push();
  });
  petWindow.once('ready-to-show', () => {
    if (readState().visible !== false) {
      petWindow.showInactive();
      syncChrome(true);
    } else {
      syncChrome(false);
    }
    push();
  });
  petWindow.on('moved', () => {
    if (petWindow && !petWindow.isDestroyed()) writeState({ bounds: petWindow.getBounds() });
  });
  petWindow.on('closed', () => { petWindow = null; });

  return petWindow;
}

/**
 * The medallion that stands in for a hidden pet.
 *
 * Built on first use rather than at startup: a user who never hides the pet
 * never pays for a second renderer process.
 */
function createLauncherWindow() {
  if (launcherWindow && !launcherWindow.isDestroyed()) return launcherWindow;

  const size = launcherSize();
  const { x, y } = resolveLauncherPosition();

  launcherWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    title: 'DSH 桌宠',
    webPreferences: {
      preload: path.join(__dirname, 'pet-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  try { launcherWindow.setAlwaysOnTop(true, 'screen-saver'); } catch { /* older electron */ }
  pinSize(launcherWindow, size);
  applyZoom(launcherWindow);
  applyClickThrough(launcherWindow);

  launcherWindow.loadFile(path.join(ROOT, 'renderer', 'launcher.html'), DEBUG_HIT
    ? { query: { debughit: '1' } }
    : undefined);
  if (DEBUG_HIT) {
    launcherWindow.webContents.on('console-message', (_event, _level, message) => {
      try { console.log(`[launcher] ${message}`); } catch { /* ignore */ }
    });
  }
  launcherWindow.webContents.on('did-finish-load', () => {
    applyZoom(launcherWindow);
    push();
  });
  launcherWindow.on('moved', () => {
    if (launcherWindow && !launcherWindow.isDestroyed()) {
      writeState({ launcherBounds: launcherWindow.getBounds() });
    }
  });
  launcherWindow.on('closed', () => { launcherWindow = null; });

  return launcherWindow;
}

function raiseWindows() {
  for (const win of [petWindow, launcherWindow]) {
    if (!win || win.isDestroyed() || !win.isVisible()) continue;
    try { win.moveTop(); } catch { /* ignore */ }
  }
}

/** Exactly one window is on screen: the mascot, or the medallion standing in for it. */
function syncChrome(petShown) {
  if (petShown) hideLauncher();
  else showLauncher();
}

function hideLauncher() {
  if (launcherWindow && !launcherWindow.isDestroyed() && launcherWindow.isVisible()) {
    launcherWindow.hide();
  }
}

function showLauncher() {
  const win = createLauncherWindow();
  if (!win || win.isDestroyed()) return false;

  // the saved spot may no longer exist (monitor unplugged, resolution change),
  // and an off-screen medallion is indistinguishable from a missing one
  const size = launcherSize();
  const bounds = win.getBounds();
  const area = areaOfPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const fits = bounds.x + bounds.width > area.x && bounds.x < area.x + area.width
    && bounds.y + bounds.height > area.y && bounds.y < area.y + area.height;
  if (!fits) {
    const target = {
      ...clampToArea({ x: bounds.x, y: bounds.y, width: size.width, height: size.height }, area),
      width: size.width,
      height: size.height,
    };
    repositionWindow(win, target);
    writeState({ launcherBounds: target });
  }

  if (!win.isVisible()) win.showInactive();
  try { win.moveTop(); } catch { /* ignore */ }
  return true;
}

function hidePet() {
  writeState({ visible: false });
  if (petWindow && !petWindow.isDestroyed()) petWindow.hide();
  syncChrome(false);
}

function showPet() {
  if (!petWindow || petWindow.isDestroyed()) return false;
  writeState({ visible: true });

  // the saved spot may no longer exist (monitor unplugged, resolution change),
  // and an off-screen window is indistinguishable from a missing one
  const size = petSize();
  const bounds = petWindow.getBounds();
  const area = areaOfPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const fits = bounds.x + bounds.width > area.x && bounds.x < area.x + area.width
    && bounds.y + bounds.height > area.y && bounds.y < area.y + area.height;
  if (!fits) {
    const target = {
      ...clampToArea({ x: bounds.x, y: bounds.y, width: size.width, height: size.height }, area),
      width: size.width,
      height: size.height,
    };
    repositionWindow(petWindow, target);
    writeState({ bounds: target });
  }

  petWindow.showInactive();
  syncChrome(true);
  raiseWindows();
  push();
  return true;
}

function petIsVisible() {
  // the window is the truth; the flag alone can be stale
  return Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible());
}

function launcherIsVisible() {
  return Boolean(launcherWindow && !launcherWindow.isDestroyed() && launcherWindow.isVisible());
}

function togglePet() {
  if (petIsVisible()) hidePet();
  else showPet();
}

/**
 * Park the pet at the primary display's bottom-right corner and show it.
 * This is the recovery move for "it is running but I cannot find it": whatever
 * display layout the saved position was recorded under, this lands somewhere
 * the user is definitely looking.
 */
function snapToCorner() {
  if (!petWindow || petWindow.isDestroyed()) return false;
  const size = petSize();
  const area = screen.getPrimaryDisplay().workArea;
  const target = {
    x: area.x + area.width - size.width - 12,
    y: area.y + area.height - size.height - 12,
    width: size.width,
    height: size.height,
  };
  repositionWindow(petWindow, target);
  writeState({ bounds: target });
  showPet();
  return true;
}

// ------------------------------------------------------------------- gestures ---
function windowOf(which) {
  return which === 'launcher' ? launcherWindow : petWindow;
}

function sizeOf(which) {
  return which === 'launcher' ? launcherSize() : petSize();
}

function stateKeyOf(which) {
  return which === 'launcher' ? 'launcherBounds' : 'bounds';
}

function beginDrag(which) {
  const win = windowOf(which);
  if (!win || win.isDestroyed()) return false;
  const point = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  const grab = { dx: point.x - bounds.x, dy: point.y - bounds.y };
  if (which === 'launcher') launcherGrab = grab;
  else petGrab = grab;
  return true;
}

/**
 * Moves (and optionally resizes) a window, then re-asserts click-through.
 *
 * Every repositioning goes through here because moving a window is exactly when
 * Windows can hand it back a mouse-enabled state — a re-home after a display
 * change, a snap, a scale change. Doing it at the call sites was how the pet
 * ended up with a click-eating rectangle on the secondary display.
 */
function repositionWindow(win, bounds) {
  if (!win || win.isDestroyed()) return false;
  win.setBounds(bounds);
  applyClickThrough(win);
  return true;
}

/** One frame of dragging: put the grabbed point back under the cursor. */
function followCursor(which) {
  const win = windowOf(which);
  const grab = which === 'launcher' ? launcherGrab : petGrab;
  if (!grab || !win || win.isDestroyed()) return false;
  const size = sizeOf(which);
  const point = screen.getCursorScreenPoint();
  // Deliberately NOT clamped to the work area: clamping mid-drag stalls the
  // window at a screen edge while the cursor keeps going, which makes the
  // character slide out from under the pointer.
  //
  // No click-through re-assert here on purpose: a drag only starts from an armed
  // window, and calling setIgnoreMouseEvents mid-gesture would drop the pointer
  // capture and make the character fall out from under the cursor.
  win.setBounds({
    x: Math.round(point.x - grab.dx),
    y: Math.round(point.y - grab.dy),
    width: size.width,
    height: size.height,
  });
  return true;
}

function endDrag(which) {
  const win = windowOf(which);
  if (which === 'launcher') launcherGrab = null;
  else petGrab = null;
  if (!win || win.isDestroyed()) return false;
  writeState({ [stateKeyOf(which)]: win.getBounds() });
  return true;
}

/** Only writes when the window is genuinely outside: setBounds can nudge by a pixel. */
function clampWindow(which) {
  const win = windowOf(which);
  if (!win || win.isDestroyed()) return null;
  const size = sizeOf(which);
  const bounds = win.getBounds();
  const area = areaOfPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const right = area.x + area.width - size.width;
  const bottom = area.y + area.height - size.height;
  if (bounds.x >= area.x && bounds.y >= area.y && bounds.x <= right + 2 && bounds.y <= bottom + 2) {
    return bounds;
  }
  const target = {
    x: Math.min(Math.max(bounds.x, area.x), right),
    y: Math.min(Math.max(bounds.y, area.y), bottom),
    width: size.width,
    height: size.height,
  };
  repositionWindow(win, target);
  writeState({ [stateKeyOf(which)]: win.getBounds() });
  return target;
}

/** Bottom-right of whichever display the window currently sits on. */
function snapWindow(which) {
  const win = windowOf(which);
  if (!win || win.isDestroyed()) return false;
  const size = sizeOf(which);
  const bounds = win.getBounds();
  const area = areaOfPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const target = {
    x: area.x + area.width - size.width - 12,
    y: area.y + area.height - size.height - 12,
    width: size.width,
    height: size.height,
  };
  const same = bounds.x === target.x && bounds.y === target.y
    && bounds.width === target.width && bounds.height === target.height;
  if (!same) repositionWindow(win, target);
  writeState({ [stateKeyOf(which)]: target });
  return true;
}

function moveWindowTo(which, point) {
  const win = windowOf(which);
  if (!win || win.isDestroyed()) return false;
  const x = point ? Number(point.x) : NaN;
  const y = point ? Number(point.y) : NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const size = sizeOf(which);
  // move WITH the size: Windows can resize a window it sees being repositioned
  repositionWindow(win, { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height });
  return true;
}

// ------------------------------------------------------------ control channel ---
/** One command per connection; replies with a single status line. */
function controlReply(command) {
  const [verb, argument] = command.split(/[\s:=]+/);
  switch (verb) {
    case 'status':
      return `pet visible=${petIsVisible() ? 1 : 0} launcher=${launcherIsVisible() ? 1 : 0} scale=${scale} busy=${busyNow() ? 1 : 0} state=${stateNow()} clickthrough=${clickThrough ? 1 : 0}`;
    case 'clickthrough': {
      // Live toggle, so the click-through behaviour can be checked from a shell
      // without editing config and restarting the desktop app.
      clickThrough = argument !== '0';
      applyClickThrough(petWindow);
      applyClickThrough(launcherWindow);
      return `pet clickthrough=${clickThrough ? 1 : 0}`;
    }
    case 'busy': {
      // The host's own verdict on whether the agent is working — authoritative
      // while it keeps arriving. Pushing here is what makes the chewing start and
      // stop on the turn's edges instead of on the next 5 s metrics poll.
      const on = argument === '1' || argument === 'true' || argument === 'on';
      if (setHostBusy(on)) push();
      return `pet busy=${busyNow() ? 1 : 0}`;
    }
    case 'state': {
      // The full frame: `state:{"state":"working","tool":{...},"step":2,...}`.
      // The argument is the JSON after the first colon, so rejoin what the
      // command splitter took apart.
      if (!noteHostState(command.slice(verb.length + 1))) return 'pet state=stale';
      push();
      return `pet state=${stateNow()}`;
    }
    case 'show':   showPet(); return `pet visible=${petIsVisible() ? 1 : 0}`;
    case 'hide':   hidePet(); return `pet visible=${petIsVisible() ? 1 : 0}`;
    case 'snap':   snapToCorner(); return `pet visible=${petIsVisible() ? 1 : 0}`;
    case 'toggle': togglePet(); return `pet visible=${petIsVisible() ? 1 : 0}`;
    case 'scale':  setScale(argument); return `pet scale=${scale}`;
    case 'quit':   setTimeout(() => app.quit(), 50); return 'pet quitting';
    default:       return 'pet unknown-command';
  }
}

/**
 * Claim PET_CONTROL_PORT, which is also how a duplicate pet is detected.
 *
 * Resolves false when another pet already owns the port. A squatter that does
 * *not* answer like a pet is ignored rather than fatal, so an unrelated program
 * on this port cannot stop the pet from existing.
 */
function claimControlPort() {
  return new Promise((resolve) => {
    controlServer = net.createServer((socket) => {
      let buffered = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffered += chunk;
        const end = buffered.indexOf('\n');
        if (end === -1) return;
        const command = buffered.slice(0, end).trim().toLowerCase();
        buffered = buffered.slice(end + 1);
        socket.end(`${controlReply(command)}\n`);
      });
      socket.on('error', () => { /* a dropped probe is not an error */ });
    });

    controlServer.once('error', (error) => {
      if (error.code !== 'EADDRINUSE') {
        console.error(`pet control listener unavailable: ${error.message}`);
        resolve(true);
        return;
      }
      // someone holds the port — ask whether it is one of us
      const probe = net.connect({ host: '127.0.0.1', port: PET_CONTROL_PORT });
      let reply = '';
      const settle = (isPet) => {
        probe.removeAllListeners();
        probe.destroy();
        controlServer = null;
        if (isPet) resolve(false);
        else {
          console.error(`port ${PET_CONTROL_PORT} is held by another program; running without a single-instance lock`);
          resolve(true);
        }
      };
      probe.setTimeout(600);
      probe.once('connect', () => probe.end('status\n'));
      probe.on('data', (chunk) => { reply += chunk; });
      probe.once('end', () => settle(reply.trim().startsWith('pet')));
      probe.once('timeout', () => settle(false));
      probe.once('error', () => settle(false));
    });

    controlServer.listen(PET_CONTROL_PORT, '127.0.0.1', () => resolve(true));
  });
}

// --------------------------------------------------------------- focus relay ---
/** Asks the main app to surface its window. Silent no-op when it is not running. */
function requestMainWindow() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: FOCUS_PORT });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(600);
    socket.once('connect', () => {
      socket.end('focus\n', () => done(true));
    });
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// ---------------------------------------------------------------------- ipc ----
function scaleSubmenu() {
  return {
    label: '桌宠大小',
    submenu: SCALES.map((value) => ({
      label: `${Math.round(value * 100)}%`,
      type: 'radio',
      checked: Math.abs(scale - value) < 0.001,
      click: () => setScale(value),
    })),
  };
}

function buildPetMenu() {
  return Menu.buildFromTemplate([
    { label: '打开 DeepSeek Harness', click: () => requestMainWindow() },
    { label: '刷新用量与余额', click: () => { metrics.refresh(); balance.refresh(); push(); } },
    { type: 'separator' },
    scaleSubmenu(),
    { type: 'separator' },
    { label: '隐藏桌宠', click: () => hidePet() },
    { label: '显示在右下角', click: () => snapToCorner() },
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() },
  ]);
}

function buildLauncherMenu() {
  return Menu.buildFromTemplate([
    { label: '唤回桌宠', click: () => showPet() },
    { label: '打开 DeepSeek Harness', click: () => requestMainWindow() },
    { label: '刷新用量与余额', click: () => { metrics.refresh(); balance.refresh(); push(); } },
    { type: 'separator' },
    scaleSubmenu(),
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() },
  ]);
}

function registerIpc() {
  ipcMain.handle('state:get', () => snapshot());
  ipcMain.handle('state:refresh', async () => {
    metrics.refresh();
    await balance.refresh();
    return push();
  });

  ipcMain.handle('pet:frames', () => {
    const dir = path.join(ROOT, 'assets', 'pet');
    const frames = {};
    let version = 0;
    // Every expression the state machine can ask for (see lib/pet-state.js's
    // FACE_OF), plus `hover` for the cursor and `mini` for the page's button.
    // Listed rather than globbed so a stray file in the art directory cannot
    // become a reachable expression by accident.
    for (const name of ['base', 'idle', 'busy', 'chew', 'hover', 'alert', 'mini']) {
      const file = path.join(dir, `${name}.png`);
      try {
        const buf = fs.readFileSync(file);
        for (const byte of buf) version = (version * 31 + byte) >>> 0;
        frames[name] = `data:image/png;base64,${buf.toString('base64')}`;
      } catch {
        /* a missing frame leaves that expression unavailable */
      }
    }
    return { version: version.toString(36), frames };
  });

  ipcMain.handle('window:show', () => requestMainWindow());

  ipcMain.handle('pet:show', () => showPet());
  ipcMain.handle('pet:hide', () => { hidePet(); return true; });
  ipcMain.handle('pet:toggle', () => { togglePet(); return petIsVisible(); });

  for (const which of ['pet', 'launcher']) {
    const prefix = which === 'pet' ? 'pet' : 'launcher';
    ipcMain.handle(`${prefix}:drag-begin`, () => beginDrag(which));
    ipcMain.handle(`${prefix}:drag-end`, () => endDrag(which));
    ipcMain.handle(`${prefix}:follow`, () => followCursor(which));
    ipcMain.handle(`${prefix}:clamp`, () => clampWindow(which));
    ipcMain.handle(`${prefix}:move-to`, (_event, point) => moveWindowTo(which, point));
    ipcMain.handle(`${prefix}:snap`, () => snapWindow(which));
    // The renderer owns the hit test (it has the art), the main process owns the
    // window flag. See applyClickThrough().
    ipcMain.handle(`${prefix}:interactive`, (_event, on) => setInteractive(which, Boolean(on)));
  }

  ipcMain.handle('pet:menu', () => {
    buildPetMenu().popup({ window: petWindow });
    return true;
  });
  ipcMain.handle('launcher:menu', () => {
    buildLauncherMenu().popup({ window: launcherWindow });
    return true;
  });
}

// ------------------------------------------------------------------ lifecycle --
/** Entry point, called from pet-app/main.js when the process is started with --pet. */
function run() {
  app.whenReady().then(async () => {
    app.commandLine.appendSwitch('disable-background-timer-throttling');

    // Claim the control port *before* building anything: the pet is spawned on
    // every app start and outlives the app, so without this lock they pile up,
    // each one an extra invisible window holding its own metrics poller.
    const claimed = await claimControlPort();
    if (!claimed) {
      console.log('a pet is already running; this one is exiting');
      app.exit(0);
      return;
    }

    scale = resolveInitialScale();
    // Plugin config wins over the default, but the pet's own saved state does not
    // carry this one: a click-through preference is the plugin's to set.
    clickThrough = process.env.DSH_PET_CLICK_THROUGH !== '0';

    metrics = new Metrics();
    metrics.refresh();
    balance = new Balance({ onUpdate: () => push() });
    balance.start();

    registerIpc();
    // the medallion is built by syncChrome() the first time the pet is hidden —
    // see createPetWindow()'s ready-to-show handler
    createPetWindow();

    const topGuard = setInterval(() => raiseWindows(), 20000);
    if (typeof topGuard.unref === 'function') topGuard.unref();

    startCursorWatch();

    const poll = setInterval(() => {
      metrics.refresh();
      push();
    }, 5000);
    if (typeof poll.unref === 'function') poll.unref();

    push();
  });

  app.on('window-all-closed', () => app.quit());   // the pet's windows ARE the app
  app.on('will-quit', () => {
    if (balance) balance.stop();
    if (controlServer) {
      try { controlServer.close(); } catch { /* already closed */ }
      controlServer = null;
    }
  });
}

module.exports = { run };
