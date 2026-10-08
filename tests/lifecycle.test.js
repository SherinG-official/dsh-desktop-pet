import { describe, it, expect } from 'vitest'

import {
  name,
  Config,
  apply,
  busyCommand,
  createBusyRelay,
  parsePetStatus,
  resolveCommand,
  resolveArgs,
  resolveCwd,
  CONTROL_ROUTE,
} from '../lib/index.js'

/**
 * A stand-in for the harness context that records what the plugin registers.
 *
 * `services` seeds `ctx.inject` with the ones the caller declares available, so
 * a test can assert both "the control panel waits for a web server" and "the
 * control panel still exists without one".
 */
function fakeCtx(services = {}) {
  const effects = []
  const logs = []
  const injected = []
  const routes = []
  const disposers = []
  const listeners = new Map()

  // The sub-scope a `ctx.inject` callback receives runs its effects the way the
  // real context does — immediately, collecting the disposer — because that is
  // exactly how a route registration reaches the web server.
  const scope = {
    effect(fn) {
      disposers.push(fn())
      return () => {}
    },
    get: (key) => services[key],
    webServer: services.webServer,
  }

  return {
    effects,
    logs,
    injected,
    routes,
    disposers,
    listeners,
    /** Deliver an engine event to whatever the plugin subscribed. */
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    ctx: {
      effect(fn) {
        effects.push(fn)
        return () => {}
      },
      inject(deps, callback) {
        injected.push(deps)
        if (deps.every((dep) => services[dep] !== undefined)) callback(scope, undefined)
        return () => {}
      },
      on(event, listener) {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event).add(listener)
        return () => listeners.get(event)?.delete(listener)
      },
      logger: () => ({
        info: (m) => logs.push(`info: ${m}`),
        error: (m) => logs.push(`error: ${m}`),
      }),
    },
  }
}

/** A web server double that records the routes registered on it. */
function fakeWebServer(routes) {
  return {
    host: '127.0.0.1',
    port: 19387,
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const runningChild = (config) => ({
  ...Config(config),
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
  restartDelayMs: 0,
})

describe('plugin contract', () => {
  it('exposes the required name', () => {
    expect(name).toBe('dsh-desktop-pet')
  })

  it('applies defaults through the Schemastery schema', () => {
    const cfg = Config({})
    expect(cfg.enabled).toBe(true)
    expect(cfg.restartDelayMs).toBe(2000)
    expect(cfg.maxRestarts).toBe(5)
    expect(cfg.scale).toBe(1)
    expect(cfg.controlPanel).toBe(true)
    expect(Array.isArray(cfg.args)).toBe(true)
  })

  it('accepts a size and hands it to the window as its initial scale', () => {
    expect(Config({ scale: 1.25 }).scale).toBe(1.25)
    expect(Config({ scale: 0.75 }).scale).toBe(0.75)
  })

  it('rejects an invalid config loudly instead of silently defaulting', () => {
    expect(() => Config({ restartDelayMs: 'not-a-number' })).toThrow()
  })

  it('registers the window lifecycle and the busy relay, and only the relay when disabled', () => {
    // Two effects now: owning the window process, and keeping its face in step
    // with the engine. The relay is registered even with the pet switched off,
    // because the control panel can start the window later and then the relay
    // has to be listening already.
    const on = fakeCtx()
    apply(on.ctx, runningChild({}), { busySend: async () => null })
    expect(on.effects).toHaveLength(2)

    const off = fakeCtx()
    apply(off.ctx, Config({ enabled: false }), { busySend: async () => null })
    expect(off.effects).toHaveLength(1)
  })
})

describe('control API', () => {
  it('serves the control route on the web server when one is available', () => {
    const routes = []
    const { ctx, injected } = fakeCtx({ webServer: fakeWebServer(routes) })
    apply(ctx, Config({ enabled: false }))

    expect(injected).toEqual([['webServer']])
    expect(routes).toHaveLength(1)
    expect(routes[0].kind).toBe('exact')
    expect(routes[0].path).toBe(CONTROL_ROUTE)
    expect(typeof routes[0].handler).toBe('function')
  })

  it('waits for a web server instead of requiring one', () => {
    // The pet is a desktop feature. A profile with no web carrier must still get
    // its pet rather than a plugin that never activates.
    const { ctx, injected } = fakeCtx()
    apply(ctx, Config({ enabled: false }))
    expect(injected).toEqual([['webServer']])
  })

  it('registers nothing on the web server when the panel is switched off', () => {
    const routes = []
    const { ctx, injected } = fakeCtx({ webServer: fakeWebServer(routes) })
    apply(ctx, Config({ enabled: false, controlPanel: false }))
    expect(injected).toHaveLength(0)
    expect(routes).toHaveLength(0)
  })
})

describe('control port replies', () => {
  it('reads the full status line', () => {
    expect(parsePetStatus('pet visible=1 launcher=0 scale=1.25')).toEqual({
      raw: 'pet visible=1 launcher=0 scale=1.25',
      visible: true,
      launcher: false,
      scale: 1.25,
    })
  })

  it('keeps absent fields absent instead of inventing them', () => {
    // `hide` answers with `visible` alone: reporting scale=1 there would be a
    // plausible-looking lie about the size the user picked.
    expect(parsePetStatus('pet visible=0')).toEqual({ raw: 'pet visible=0', visible: false })
  })

  it('reads the busy flag the window reports', () => {
    expect(parsePetStatus('pet visible=1 launcher=0 scale=1 busy=1').busy).toBe(true)
    expect(parsePetStatus('pet visible=1 busy=0').busy).toBe(false)
    expect(parsePetStatus('pet visible=1').busy).toBeUndefined()
  })

  it('rejects anything that is not a pet', () => {
    expect(parsePetStatus(null)).toBeNull()
    expect(parsePetStatus('')).toBeNull()
    expect(parsePetStatus('HTTP/1.1 404 Not Found')).toBeNull()
  })
})

describe('busy relay', () => {
  /** A recorder standing in for the window's control port. */
  function recorder() {
    const sent = []
    return { sent, send: (line) => { sent.push(line) } }
  }

  it('maps the verdict onto the control line the window understands', () => {
    expect(busyCommand(true)).toBe('busy:1')
    expect(busyCommand(false)).toBe('busy:0')
  })

  it('reports the edges, not the events', () => {
    // The engine emits one status event per agent. The face only cares whether
    // *any* of them is running, so a second agent starting must not cost a line.
    const { sent, send } = recorder()
    const relay = createBusyRelay({ send })

    expect(relay.isBusy()).toBe(false)
    relay.note({ id: 'a' }, 'running')
    expect(sent).toEqual(['busy:1'])
    relay.note({ id: 'b' }, 'running')
    expect(sent).toEqual(['busy:1'])
    relay.note({ id: 'a' }, 'idle')
    expect(sent).toEqual(['busy:1'])          // b is still running
    expect(relay.isBusy()).toBe(true)
    relay.note({ id: 'b' }, 'idle')
    expect(sent).toEqual(['busy:1', 'busy:0'])
    expect(relay.isBusy()).toBe(false)
  })

  it('forgets an agent that never reports idle', () => {
    const { sent, send } = recorder()
    const relay = createBusyRelay({ send })
    relay.note({ id: 'a' }, 'running')
    relay.forget({ id: 'a' })
    expect(sent).toEqual(['busy:1', 'busy:0'])
  })

  it('re-states the verdict on a heartbeat, so a window started mid-turn hears it', async () => {
    // The edge that started the turn is long gone by then, and the window has no
    // way to ask: without the heartbeat a pet launched mid-turn stays idle.
    const { sent, send } = recorder()
    const relay = createBusyRelay({ send, heartbeatMs: 15 })
    relay.note({ id: 'a' }, 'running')
    relay.start()
    await sleep(55)
    relay.stop()

    expect(sent.filter((line) => line === 'busy:1').length).toBeGreaterThan(1)
    expect(sent[sent.length - 1]).toBe('busy:0')

    // stop() must also stop the heartbeat, or a disposed plugin keeps talking
    const settled = sent.length
    await sleep(45)
    expect(sent.length).toBe(settled)
  })

  it('subscribes to the engine and stands the window down when the plugin unloads', () => {
    // Wired through apply() on purpose: the plugin's own subscription is what
    // the engine has to reach, and unloading must not leave the pet chewing.
    const sent = []
    const { ctx, effects, listeners, emit } = fakeCtx()
    apply(ctx, Config({ enabled: false }), { busySend: (line) => { sent.push(line) } })

    // The relay's own effect is what subscribes; running it is what a real
    // context does at registration time.
    const dispose = effects[0]()
    expect([...listeners.keys()].sort()).toEqual(['agent/disposed', 'agent/status'])
    emit('agent/status', { agent: { id: 'a' }, status: 'running' })
    expect(sent).toEqual(['busy:1'])

    dispose()
    expect(sent).toEqual(['busy:1', 'busy:0'])
    expect(listeners.get('agent/status').size).toBe(0)
  })
})

describe('path resolution', () => {
  it('honours explicit overrides', () => {
    const cfg = Config({ command: 'C:/x/e.exe', args: ['--flag'], cwd: 'C:/x' })
    expect(resolveCommand(cfg)).toBe('C:/x/e.exe')
    expect(resolveArgs(cfg)).toEqual(['--flag'])
    expect(resolveCwd(cfg)).toBe('C:/x')
  })

  it('defaults to an electron runtime and the packaged window entry', () => {
    const cfg = Config({})
    expect(resolveCommand(cfg).endsWith('electron.exe')).toBe(true)
    expect(resolveArgs(cfg)).toHaveLength(1)
    expect(resolveArgs(cfg)[0].endsWith('pet-app')).toBe(true)
    // runtime state lives in the DSH home: never the user profile (its NTUSER.DAT
    // lock takes file watchers down) and never inside the package (a running
    // window would hold its own plugin directory, blocking pnpm updates)
    const cwd = resolveCwd(cfg)
    expect(cwd.endsWith('desktop-pet')).toBe(true)
    expect(cwd).not.toContain('node_modules')
  })
})

describe('lifecycle', () => {
  it('starts the pet when activated and kills it on dispose', async () => {
    const { ctx, effects, logs } = fakeCtx()
    apply(ctx, runningChild({}))

    const dispose = effects[0]()
    await sleep(400)

    const started = logs.find((l) => l.includes('pet window started'))
    expect(started).toBeTruthy()
    const pid = Number(started.match(/pid (\d+)/)[1])
    expect(alive(pid)).toBe(true)

    dispose()
    await sleep(500)
    expect(alive(pid)).toBe(false)
  })

  it('restarts after a crash, but not after a clean exit', async () => {
    // crash: exit 1
    const crash = fakeCtx()
    apply(crash.ctx, {
      ...Config({ restartDelayMs: 150, maxRestarts: 2 }),
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
    })
    const disposeCrash = crash.effects[0]()
    await sleep(900)
    const starts = crash.logs.filter((l) => l.includes('pet window started')).length
    expect(starts).toBeGreaterThan(1)
    disposeCrash()

    // clean exit: code 0 must NOT be restarted (that is the user closing the pet)
    const clean = fakeCtx()
    apply(clean.ctx, {
      ...Config({ restartDelayMs: 100 }),
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    })
    const disposeClean = clean.effects[0]()
    await sleep(700)
    expect(clean.logs.filter((l) => l.includes('pet window started')).length).toBe(1)
    disposeClean()
  })

  it('reports a missing runtime instead of failing silently', async () => {
    const { ctx, effects, logs } = fakeCtx()
    apply(ctx, Config({ command: 'C:/definitely/not/here.exe' }))
    effects[0]()
    await sleep(200)
    expect(logs.some((l) => l.includes('pet window runtime not found'))).toBe(true)
  })
})
