import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, appendFileSync, openSync, closeSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-desktop-pet'

// lib/ sits one level below the package root, and everything this plugin ships
// (window entry, renderer, art) is addressed from the package root
const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const require = createRequire(import.meta.url)

// The window's own contract, shared rather than restated: the control port it
// listens on, and the size ladder its menu offers.
const { PET_CONTROL_PORT } = require('../src/focus-port.js')
const { SCALES } = require('../src/scales.js')

/** The one HTTP route this plugin owns. */
export const CONTROL_ROUTE = '/dsh-desktop-pet'

const ICON_FILE = path.join(HERE, 'assets', 'pet', 'mini.png')

// The harness gives plugins a logger, but whether its output is reachable
// depends on how the host was launched — and when a plugin silently fails to
// activate there is otherwise nothing to inspect. Append to a fixed file so the
// plugin's own view of its lifecycle survives regardless of the host's logging.
const TRACE_FILE = path.join(
  process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'),
  'desktop-pet-plugin.log',
)

function trace(message) {
  try {
    appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* tracing must never break the plugin */
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

trace(`module loaded (node ${process.version}, electron=${process.versions.electron || 'no'}, packaged=${process.versions.electron ? 'yes' : 'no'})`)

/**
 * The desktop pet, as a DSH Host plugin.
 *
 * Why a plugin instead of a standalone app
 * ----------------------------------------
 * The pet needs a floating, always-on-top, transparent, draggable window. The
 * plugin surface cannot make one: a Client module (`dsh.client`) runs inside the
 * harness page, and a Host plugin runs in Node with no Electron APIs. So the
 * window stays its own process, and this plugin is what owns it — the plugin
 * manages lifecycle, configuration, installation and the control surface, the
 * window process does the drawing.
 *
 * Lifecycle
 * ---------
 * The pet is started when the plugin activates and stopped when it unloads, as a
 * single `ctx.effect()` with one disposer. That is the contract (registration is
 * an effect) and it is also what makes the pet behave: toggling the plugin off in
 * the harness actually stops the pet, and hot-reloading the plugin does not leave
 * an orphan behind.
 *
 * On top of that, the controller below is a small state machine with explicit
 * `start`, `stop` and `ensureRunning` verbs, because the pet outlives every
 * reason it was started for:
 *
 *   - a crash restarts it after `restartDelayMs` (a crash loop costs one pet,
 *     not the whole feature);
 *   - the pet's own "退出桌宠" is a clean exit (code 0) and is deliberately NOT
 *     restarted — it means "I am done with this thing";
 *   - and because that clean exit used to be the end of the road until the whole
 *     desktop app restarted, those verbs are reachable from outside: the control
 *     panel in the harness page calls them over the HTTP route below.
 */

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('是否在插件激活时拉起桌宠浮窗。'),
  command: Schema.string()
    .default('')
    .description('启动浮窗的可执行文件。留空则用随插件安装的 electron。'),
  args: Schema.array(Schema.string())
    .default([])
    .description('传给 command 的参数。留空则用内置的浮窗入口。'),
  cwd: Schema.string()
    .default('')
    .description('浮窗进程的工作目录。留空则用 <DSH 主目录>/desktop-pet（不放插件包内，否则运行中的浮窗会锁住包目录、导致插件无法更新；也不放用户主目录，那里的 NTUSER.DAT 锁会让监视器挂掉）。'),
  restartDelayMs: Schema.number()
    .default(2000)
    .description('浮窗异常退出后重新拉起的延迟（毫秒）。设为 0 表示退出后不再拉起。'),
  maxRestarts: Schema.number()
    .default(5)
    .description('连续异常退出的次数上限，超过后停止重启并记录一次错误。'),
  scale: Schema.number()
    .default(1)
    .description('桌宠初始缩放比例，0.5–2（常用 0.75 / 1 / 1.25 / 1.5）。这是首次启动的初值：之后在桌宠或右下角小圆钮上右键选「桌宠大小」即可随时调整，调整结果会被记住并覆盖此值。'),
  controlPanel: Schema.boolean()
    .default(true)
    .description(`是否在 harness 的 Web 服务上注册控制接口 ${CONTROL_ROUTE}（设置页「桌宠」面板与输入框旁的小按钮都走它）。关掉后浮窗本身照常工作，只是页面里没有控制按钮。`),
})

/**
 * Resolves the executable that hosts the pet window.
 *
 * Electron is never at a fixed relative path here: the profile installs with
 * `nodeLinker: hoisted`, so a plugin's dependency lands in the profile's own
 * node_modules rather than a nested one. Resolving through the module system
 * finds it wherever the linker actually put it.
 */
export function resolveCommand(config) {
  if (config.command) return config.command

  // A runtime installed outside pnpm wins, when one is present.
  //
  // pnpm's side-effects cache is unreliable for electron here: the postinstall
  // result fails to upload, leaving a partial "already built" record that every
  // later install replays — the dist comes back missing electron.exe (and a few
  // other large files), and the window cannot start. An npm-installed runtime in
  // the DSH home is not touched by profile installs, so preferring it makes the
  // pet survive any number of plugin installs.
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  const stable = path.join(home, 'desktop-pet-runtime', 'node_modules', 'electron', 'dist', 'electron.exe')
  if (existsSync(stable)) return stable

  // Otherwise walk the directories by hand. Inside Electron-as-Node every module
  // lookup misleads: `require('electron')` yields the Electron API object, not a
  // path, and `require.resolve('electron')` matches the built-in module rather
  // than anything on disk — while the npm package's own `exports` map rejects
  // `electron/package.json`. Directory walking is the only lookup that behaves
  // identically under hoisted and nested linking, and it needs no module system.
  //
  // Two shapes have to be tested at each level: an ancestor may be a package root
  // (`<root>/node_modules/electron`) or already be a node_modules directory, which
  // is exactly what the parent of an installed plugin is (`<root>/node_modules`
  // then `electron` directly — appending node_modules again looks for
  // node_modules/node_modules and silently misses it).
  let dir = HERE
  for (let depth = 0; depth < 8; depth += 1) {
    const nested = path.join(dir, 'node_modules', 'electron', 'dist', 'electron.exe')
    if (existsSync(nested)) return nested
    const sibling = path.join(dir, 'electron', 'dist', 'electron.exe')
    if (existsSync(sibling)) return sibling
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  try {
    // a plain Node process (tests, CLI) can still answer directly
    const resolved = require('electron')
    if (typeof resolved === 'string' && existsSync(resolved)) return resolved
  } catch {
    /* nothing resolvable: the caller reports it */
  }
  return path.join(HERE, 'node_modules', 'electron', 'dist', 'electron.exe')
}

/** Resolves the argument list handed to that executable. */
export function resolveArgs(config) {
  if (config.args.length > 0) return config.args
  return [path.join(HERE, 'pet-app')]
}

/**
 * Working directory for the window process.
 *
 * Never the user profile — its NTUSER.DAT lock takes file watchers down — and
 * never inside the plugin package either: the running window holds its cwd open,
 * which makes the package directory unrenamable and permanently blocks pnpm from
 * updating the plugin (ERR_PNPM_EPERM renaming dsh-desktop-pet_tmp_* on the next
 * install). The DSH home is the right place for a plugin's runtime state.
 */
export function resolveCwd(config) {
  if (config.cwd) return config.cwd
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  return path.join(home, 'desktop-pet')
}

// ------------------------------------------------------------- pet control IO ---
/**
 * One line in, one line out, over the port the window listens on.
 *
 * Returns null whenever the window is not there — the normal answer before it
 * has been started, not an error. Every caller treats it that way.
 */
function sendControl(command, timeoutMs = 900) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: PET_CONTROL_PORT })
    let reply = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => socket.end(`${command}\n`))
    socket.on('data', (chunk) => { reply += chunk })
    socket.once('end', () => finish(reply.trim() || null))
    socket.once('timeout', () => finish(null))
    socket.once('error', () => finish(null))
  })
}

/**
 * `pet visible=1 launcher=0 scale=1` → the fields the line actually carries.
 *
 * Partial replies are the norm — `hide` answers with `visible` alone — so an
 * absent field stays absent rather than defaulting to a plausible-looking lie.
 */
export function parsePetStatus(line) {
  if (typeof line !== 'string') return null
  const trimmed = line.trim()
  if (!trimmed.startsWith('pet')) return null

  const fields = {}
  for (const token of trimmed.split(/\s+/).slice(1)) {
    const at = token.indexOf('=')
    if (at > 0) fields[token.slice(0, at)] = token.slice(at + 1)
  }

  const state = { raw: trimmed }
  if ('visible' in fields) state.visible = fields.visible === '1'
  if ('launcher' in fields) state.launcher = fields.launcher === '1'
  if ('busy' in fields) state.busy = fields.busy === '1'
  if ('scale' in fields) {
    const value = Number(fields.scale)
    if (Number.isFinite(value)) state.scale = value
  }
  return state
}

// ----------------------------------------------------------------- busy relay ---
/** How often the verdict is re-stated, so a window that appears mid-turn still hears it. */
const HOST_BUSY_HEARTBEAT_MS = 15_000

/** The control line that sets the window's busy flag. */
export function busyCommand(on) {
  return `busy:${on ? 1 : 0}`
}

/**
 * Keeps the pet's face in step with the engine instead of with the disk.
 *
 * The window cannot answer "is the agent working?" by itself. It reads token
 * usage out of DSH's projection cache, and that cache is flushed at *step
 * boundaries*: measured 5–11 s apart on a working turn, and silent for over 40 s
 * during a single long model call. A freshness test on those files therefore
 * reads idle through most of a working turn — the pet almost never chewed.
 *
 * `agent/status` is the engine's own answer (`running` / `idle`) and the same
 * source the harness UI's own spinner uses, so the relay subscribes to it and
 * pushes the verdict down the port the window already listens on.
 *
 * Agents are plural — a subagent is one — so the flag is "any of them is
 * running", and the heartbeat re-states it, because a window started in the
 * middle of a turn would otherwise never hear the edge that already happened.
 */
export function createBusyRelay(options = {}) {
  const send = options.send ?? sendControl
  const heartbeatMs = options.heartbeatMs ?? HOST_BUSY_HEARTBEAT_MS
  /** Agents currently in `running`, by id. */
  const running = new Set()
  let last = null
  let timer = null

  const isBusy = () => running.size > 0

  async function publish(force = false) {
    const value = isBusy()
    if (!force && value === last) return value
    last = value
    try {
      await send(busyCommand(value))
    } catch {
      /* the window is not there: the next edge or heartbeat says it again */
    }
    return value
  }

  const idOf = (agent) => (agent && agent.id != null ? String(agent.id) : null)

  return {
    isBusy,
    publish,
    /** An agent entered `running` or went back to `idle`. */
    note(agent, status) {
      const id = idOf(agent)
      if (id === null) return
      if (status === 'running') running.add(id)
      else running.delete(id)
      void publish()
    },
    /** An agent left the registry: it will never report `idle` on its own. */
    forget(agent) {
      const id = idOf(agent)
      if (id === null) return
      if (running.delete(id)) void publish()
    },
    start() {
      if (timer) return
      timer = setInterval(() => { void publish(true) }, heartbeatMs)
      if (typeof timer.unref === 'function') timer.unref()
    },
    /** Stops the heartbeat and tells the window to stand down. */
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      running.clear()
      last = null
      void publish(true)
    },
  }
}

/** True while the window answers on its control port. */
async function petIsUp() {
  return parsePetStatus(await sendControl('status')) !== null
}

/**
 * Owns the window process for as long as the plugin is loaded.
 *
 * Everything about "should a pet be running right now" lives here, so the crash
 * restart, the pet's own quit and the control panel cannot disagree about it.
 */
function createController(config, log) {
  let child = null
  let timer = null
  let disposed = false
  /** A stop was asked for: the exit that follows must not be restarted. */
  let stopping = false
  let restarts = 0
  let lastExit = null

  const running = () => Boolean(child)

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const stopChild = () => {
    if (!child) return false
    const dying = child
    child = null
    try {
      dying.kill()
    } catch {
      /* already gone */
    }
    return true
  }

  /**
   * Spawns the window process.
   *
   * `reset` marks a deliberate start — the plugin activating, or someone
   * pressing the button — as opposed to the automatic restart after a crash.
   * Only a deliberate start clears the crash counter: clearing it on the
   * automatic path would make `maxRestarts` unreachable and turn a crash loop
   * into a permanent one.
   */
  function start(options = {}) {
    if (disposed) return false
    if (running()) return true
    if (options.reset) {
      restarts = 0
      stopping = false
      clearTimer()
    }

    const command = resolveCommand(config)
    trace(`start: command=${command} exists=${existsSync(command)} cwd=${resolveCwd(config)}`)
    if (!existsSync(command)) {
      log.error?.(`pet window runtime not found: ${command}`)
      return false
    }

    // The working directory must exist before spawn: a missing cwd makes spawn
    // fail with ENOENT, which reads exactly like "the executable is missing".
    const cwd = resolveCwd(config)
    try {
      mkdirSync(cwd, { recursive: true })
    } catch (error) {
      log.error?.(`cannot prepare the pet working directory ${cwd}: ${error?.message ?? error}`)
      return false
    }

    // The window's own output goes to a file rather than nowhere: a crash loop
    // is otherwise silent, and a pet that exits non-zero two seconds after
    // starting is exactly the case where the reason matters most.
    let sink = 'ignore'
    try {
      sink = openSync(path.join(cwd, 'pet-window.log'), 'a')
    } catch {
      /* fall back to discarding output */
    }

    // The host itself runs as Electron-as-Node, so its environment carries
    // ELECTRON_RUN_AS_NODE=1. Inheriting that would launch the window host as
    // a plain Node process — no `app`, no BrowserWindow, and a crash that only
    // shows up as "Cannot read properties of undefined (reading 'whenReady')".
    // The window must be a real Electron app, so the flag is stripped.
    //
    // DSH_PET_SCALE is the window's *initial* size. The user can change it from
    // the pet's own menu, and that choice is remembered in the window state
    // file, which the window reads first — so a later config change here does
    // not yank the size out from under someone who already picked one.
    const childEnv = {
      ...process.env,
      DSH_PET_CHILD: '1',
      DSH_PET_SCALE: String(config.scale),
    }
    delete childEnv.ELECTRON_RUN_AS_NODE

    let proc
    try {
      proc = spawn(command, resolveArgs(config), {
        cwd,
        detached: true,
        stdio: ['ignore', sink, sink],
        // the pet is a GUI process: no console should ever appear for it
        windowsHide: true,
        env: childEnv,
      })
    } catch (error) {
      log.error?.(`failed to start the pet window: ${error?.message ?? error}`)
      return false
    }
    if (typeof sink === 'number') {
      try { closeSync(sink) } catch { /* the child holds the handle now */ }
    }

    child = proc
    // Report success only once the process really exists. spawn() returns
    // immediately and reports failure asynchronously, so logging here would
    // claim a pid of `undefined` for a launch that never happened.
    proc.once('spawn', () => {
      log.info?.(`pet window started (pid ${proc.pid})`)
    })
    proc.on('error', (error) => {
      if (child === proc) child = null
      log.error?.(`pet window error: ${error?.message ?? error}`)
    })
    proc.on('exit', (code) => {
      if (child === proc) child = null
      lastExit = { code, at: Date.now() }
      trace(`window exited code=${code} stopping=${stopping} disposed=${disposed} restarts=${restarts}`)
      if (disposed || stopping) return
      if (code === 0) {
        // A clean exit is the user closing the pet on purpose. It is not
        // restarted automatically — the control panel is how it comes back.
        return
      }
      if (config.restartDelayMs <= 0) return
      if (restarts >= config.maxRestarts) {
        log.error?.(`pet window exited ${config.maxRestarts} times; giving up`)
        return
      }
      restarts += 1
      timer = setTimeout(() => start(), config.restartDelayMs)
    })
    proc.unref()
    return true
  }

  /**
   * Makes sure a window exists, and waits for it to claim its control port.
   *
   * Starting is not instant — Electron has to boot and bind the port — so a
   * caller that immediately wants to show or resize the pet has to wait for it,
   * or its command lands on nothing.
   */
  async function ensureRunning() {
    if (await petIsUp()) return true
    start({ reset: true })
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(150)
      if (await petIsUp()) return true
      // the child is gone and the port never answered: the spawn failed, or a
      // stray window owns the port and this one exited as a duplicate
      if (!running()) return false
    }
    return false
  }

  /** Asks the window to close itself, then makes sure it is really gone. */
  async function stop() {
    clearTimer()
    stopping = true
    if (await petIsUp()) {
      await sendControl('quit')
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(150)
        if (!running() && !(await petIsUp())) return true
      }
    }
    stopChild()
    return true
  }

  async function status() {
    const reply = parsePetStatus(await sendControl('status'))
    return {
      running: Boolean(reply) || running(),
      supervised: running(),
      pid: child ? child.pid : null,
      visible: reply?.visible ?? false,
      launcher: reply?.launcher ?? false,
      scale: reply?.scale ?? config.scale,
      sizes: SCALES,
      lastExit,
    }
  }

  function dispose() {
    disposed = true
    stopping = true
    clearTimer()
    stopChild()
  }

  return { start, stop, ensureRunning, status, dispose, running }
}

// ------------------------------------------------------------- control routes ---
function reply(res, status, body, headers = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  })
  res.end(text)
}

function replyIcon(res, headOnly) {
  let bytes
  try {
    bytes = readFileSync(ICON_FILE)
  } catch {
    reply(res, 404, { ok: false, error: 'icon missing' })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': bytes.length,
    'Cache-Control': 'public, max-age=3600',
  })
  res.end(headOnly ? undefined : bytes)
}

/**
 * One JSON endpoint for every control surface in the harness page.
 *
 * The panel and the little button beside the composer both go through here
 * rather than talking to the window directly: the window is a separate process
 * on a loopback port, and routing it through the Host keeps the port, the size
 * ladder and the "is it running" question in one place.
 */
async function handleControlRequest(req, res, controller, log) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      reply(res, 405, { ok: false, error: 'GET only' }, { Allow: 'GET' })
      return
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const action = url.searchParams.get('action') || 'status'

    if (action === 'icon') {
      replyIcon(res, req.method === 'HEAD')
      return
    }

    let note = null
    switch (action) {
      case 'status':
        break
      case 'start':
        if (!controller.start({ reset: true })) note = '浮窗运行时不在，无法启动'
        break
      case 'stop':
        await controller.stop()
        break
      case 'restart':
        await controller.stop()
        if (!controller.start({ reset: true })) note = '浮窗运行时不在，无法启动'
        break
      case 'show':
        if (await controller.ensureRunning()) await sendControl('show')
        else note = '浮窗没能起来，请查看 pet-window.log'
        break
      case 'hide':
        await sendControl('hide')
        break
      case 'toggle':
        if (await controller.ensureRunning()) await sendControl('toggle')
        else note = '浮窗没能起来，请查看 pet-window.log'
        break
      case 'scale': {
        const answer = await sendControl(`scale:${url.searchParams.get('value') ?? ''}`)
        if (!parsePetStatus(answer)) note = '桌宠没在运行，大小没有改'
        break
      }
      default:
        reply(res, 400, { ok: false, error: `unknown action "${action}"` })
        return
    }

    // A just-started window binds its control port a moment after spawn; report
    // the state the caller actually caused, not the one from before it.
    if (action === 'start' || action === 'restart') await sleep(300)
    reply(res, 200, { ok: note === null, action, note, ...(await controller.status()) })
  } catch (error) {
    log.error?.(`pet control request failed: ${error?.message ?? error}`)
    try {
      reply(res, 500, { ok: false, error: String(error?.message ?? error) })
    } catch {
      /* the socket is already gone */
    }
  }
}

/**
 * Registers the control route.
 *
 * The dependency on the web server is declared with `ctx.inject` rather than in
 * the plugin's own `inject` list on purpose: the pet is a desktop feature, and a
 * profile without a web carrier must still get its pet. Here the window simply
 * runs without a control panel, instead of the whole plugin waiting forever for
 * a service that is never coming.
 */
function registerControlApi(ctx, controller, log) {
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.webServer ?? scope.get('webServer')
    if (!webServer) {
      log.error?.('no web server available; the pet control panel will not be served')
      return
    }
    scope.effect(() => webServer.register({
      kind: 'exact',
      path: CONTROL_ROUTE,
      handler: (req, res) => handleControlRequest(req, res, controller, log),
    }), 'dsh-desktop-pet: control API')
    trace(`control API registered at ${CONTROL_ROUTE}`)
  })
}

export function apply(ctx, config, internals = {}) {
  trace(`apply called (enabled=${config.enabled}, controlPanel=${config.controlPanel})`)
  const log = ctx.logger?.('dsh-desktop-pet') ?? console
  const controller = createController(config, log)
  const busy = createBusyRelay({
    send: internals.busySend,
    heartbeatMs: internals.busyHeartbeatMs,
  })

  if (config.enabled) {
    ctx.effect(() => {
      controller.start({ reset: true })
      return () => controller.dispose()
    })
  } else {
    log.info?.('disabled by configuration; no pet started')
  }

  // The face is driven by whether the agent is working, and only the engine
  // knows that (see createBusyRelay). Registered even when the pet starts
  // disabled: the control panel can start it later, and then the relay has to be
  // listening already.
  ctx.effect(() => {
    busy.start()
    const stopStatus = ctx.on('agent/status', ({ agent, status }) => busy.note(agent, status))
    const stopDisposed = ctx.on('agent/disposed', ({ agent }) => busy.forget(agent))
    return () => {
      if (typeof stopStatus === 'function') stopStatus()
      if (typeof stopDisposed === 'function') stopDisposed()
      busy.stop()
    }
  }, 'dsh-desktop-pet: agent busy relay')

  // The control panel is registered even when the pet starts disabled: a plugin
  // switched off in configuration is exactly when a button to switch it on is
  // worth having.
  if (config.controlPanel) registerControlApi(ctx, controller, log)
}
