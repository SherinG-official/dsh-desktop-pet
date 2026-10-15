import { describe, it, expect } from 'vitest'

import { PetState, STATES, FACE_OF } from '../lib/pet-state.js'
import { createBusyRelay, stateCommand } from '../lib/index.js'

/**
 * The state machine is the pet's whole personality, and it is pure logic on
 * purpose: every rule below is a claim about what the mascot should look like
 * given what the engine did, and none of them need a window to check.
 *
 * `now` is injected so the timed states (celebration, nap) can be tested without
 * waiting for them.
 */

/** A clock the test drives by hand. */
function fakeClock(start = 1_000_000) {
  let t = start
  const now = () => t
  now.advance = (ms) => { t += ms }
  return now
}

const turnStart = (turn = 1) => ({ type: 'turn/start', data: { turn } })
const toolCall = (name = 'read_file') => ({ type: 'tool/call', data: { turn: 1, step: 1, name, arguments: '{}' } })
const turnEnd = (kind) => ({ type: 'turn/end', data: { turn: 1, reason: { kind } } })

describe('pet state machine', () => {
  it('rests when nothing is happening', () => {
    const pet = new PetState({ now: fakeClock() })
    expect(pet.snapshot().state).toBe(STATES.IDLE)
    expect(pet.snapshot().face).toBe('base')
  })

  it('thinks from the start of a turn, and works as soon as a tool is asked for', () => {
    // The distinction is the point: waiting on a model and waiting on a shell
    // command look nothing alike, and the user is waiting too.
    const pet = new PetState({ now: fakeClock() })
    pet.noteEvent(turnStart())
    expect(pet.snapshot().state).toBe(STATES.THINKING)

    pet.noteEvent(toolCall('pwsh'))
    const working = pet.snapshot()
    expect(working.state).toBe(STATES.WORKING)
    expect(working.tool).toEqual({ name: 'pwsh' })
    expect(working.face).toBe('chew')
  })

  it('goes back to thinking for each new step', () => {
    // A turn is several model calls. After the first tool returns, the model is
    // composing again — the pet should not keep chewing on a finished command.
    const pet = new PetState({ now: fakeClock() })
    pet.noteEvent(turnStart())
    pet.noteEvent(toolCall('read_file'))
    expect(pet.snapshot().state).toBe(STATES.WORKING)

    pet.noteEvent({ type: 'step/start', data: { turn: 1, step: 2 } })
    expect(pet.snapshot().state).toBe(STATES.THINKING)
  })

  it('celebrates a completed turn and settles by itself', () => {
    const now = fakeClock()
    const pet = new PetState({ now, celebrateMs: 3000 })
    pet.noteEvent(turnStart())
    pet.noteEvent(turnEnd('completed'))
    expect(pet.snapshot().state).toBe(STATES.CELEBRATE)

    now.advance(2999)
    expect(pet.snapshot().state).toBe(STATES.CELEBRATE)

    now.advance(2)
    expect(pet.snapshot().state).toBe(STATES.IDLE)
  })

  it('does not celebrate a turn the user aborted', () => {
    // Cheering because someone pressed stop is worse than saying nothing.
    const pet = new PetState({ now: fakeClock() })
    pet.noteEvent(turnStart())
    pet.noteEvent(turnEnd('aborted'))
    expect(pet.snapshot().state).toBe(STATES.IDLE)
  })

  it('does not celebrate a blocked, truncated or interrupted turn either', () => {
    for (const kind of ['blocked', 'max-tokens', 'interrupted']) {
      const pet = new PetState({ now: fakeClock() })
      pet.noteEvent(turnStart())
      pet.noteEvent(turnEnd(kind))
      expect(pet.snapshot().state, kind).toBe(STATES.IDLE)
    }
  })

  it('frowns at a turn that ended in error', () => {
    const now = fakeClock()
    const pet = new PetState({ now, errorMs: 4000 })
    pet.noteEvent(turnStart())
    pet.noteEvent(turnEnd('error'))
    expect(pet.snapshot().state).toBe(STATES.ERROR)
    expect(pet.snapshot().face).toBe('base')

    now.advance(4001)
    expect(pet.snapshot().state).toBe(STATES.IDLE)
  })

  it('lets a new turn interrupt a celebration immediately', () => {
    // Otherwise the pet keeps cheering while the agent is already working again.
    const pet = new PetState({ now: fakeClock(), celebrateMs: 3000 })
    pet.noteEvent(turnStart(1))
    pet.noteEvent(turnEnd('completed'))
    expect(pet.snapshot().state).toBe(STATES.CELEBRATE)

    pet.noteEvent(turnStart(2))
    expect(pet.snapshot().state).toBe(STATES.THINKING)
  })

  it('falls asleep after a long quiet spell, and wakes on any event', () => {
    const now = fakeClock()
    const pet = new PetState({ now, sleepAfterMs: 180_000 })
    pet.noteEvent(turnStart())
    pet.noteEvent(turnEnd('completed'))
    now.advance(3001)                    // past the celebration
    expect(pet.snapshot().state).toBe(STATES.IDLE)

    now.advance(180_001)
    expect(pet.snapshot().state).toBe(STATES.SLEEP)
    // The drawing is the resting face: the sleeping posture is CSS (a slower
    // breath and a slight sink), not an eighth asset.
    expect(pet.snapshot().face).toBe('base')

    pet.noteEvent(turnStart(2))
    expect(pet.snapshot().state).toBe(STATES.THINKING)
  })

  it('never sleeps when the nap is switched off', () => {
    const now = fakeClock()
    const pet = new PetState({ now, sleepAfterMs: 0 })
    now.advance(86_400_000)
    expect(pet.snapshot().state).toBe(STATES.IDLE)
  })

  it('is busy while any agent runs, not just the one in the foreground', () => {
    // A subagent is an agent: the pet should look busy while one is off working.
    const pet = new PetState({ now: fakeClock() })
    pet.noteStatus('main', 'running')
    pet.noteStatus('helper', 'running')
    expect(pet.isBusy()).toBe(true)

    pet.noteStatus('main', 'idle')
    expect(pet.isBusy()).toBe(true)

    pet.noteStatus('helper', 'idle')
    expect(pet.isBusy()).toBe(false)
  })

  it('forgets an agent that never reports idle', () => {
    // agent/disposed is the only signal a crashed agent gives, and a leaked id
    // would leave the pet chewing forever.
    const pet = new PetState({ now: fakeClock() })
    pet.noteStatus('gone', 'running')
    expect(pet.isBusy()).toBe(true)
    pet.forget('gone')
    expect(pet.isBusy()).toBe(false)
  })

  it('reflects a running agent even before its turn opens', () => {
    const pet = new PetState({ now: fakeClock() })
    pet.noteStatus('main', 'running')
    expect(pet.snapshot().state).toBe(STATES.THINKING)
  })

  it('settles when every agent goes idle without a turn/end', () => {
    // A cancelled or crashed run can leave the log without its closer.
    const pet = new PetState({ now: fakeClock() })
    pet.noteStatus('main', 'running')
    pet.noteStatus('main', 'idle')
    expect(pet.snapshot().state).toBe(STATES.IDLE)
  })

  it('ignores event types it does not know', () => {
    // The session log grows new event types over time; a pet that throws on an
    // unfamiliar one would take the harness down with it.
    const pet = new PetState({ now: fakeClock() })
    pet.noteEvent(turnStart())
    expect(() => pet.noteEvent({ type: 'some/future-event', data: {} })).not.toThrow()
    expect(pet.snapshot().state).toBe(STATES.THINKING)
  })

  it('degrades to idle and working when the host goes quiet', () => {
    // The window can still see the projection cache moving, so it can say
    // "working" — but it cannot tell a success from an abort, and must not guess.
    const pet = new PetState({ now: fakeClock() })
    pet.degrade(true)
    expect(pet.snapshot().state).toBe(STATES.WORKING)
    expect(pet.snapshot().degraded).toBe(true)

    // A completed turn while degraded must not produce a celebration.
    pet.noteEvent(turnEnd('completed'))
    expect(pet.snapshot().state).toBe(STATES.IDLE)

    pet.restore()
    pet.noteEvent(turnStart(2))
    pet.noteEvent(turnEnd('completed'))
    expect(pet.snapshot().state).toBe(STATES.CELEBRATE)
  })

  it('only ever draws the full-body art, never the square avatar crops', () => {
    // The art pack is not six expressions. `idle` / `busy` / `alert` are 256x256
    // portrait crops — the same family as the page button's `mini` — so drawing
    // one into the mascot's slot fills the window with a floating head, and two
    // of them carry a "Deepseek" banner. Measured in docs/pet-v2-design.md §13.
    const fullBody = new Set(['base', 'chew', 'hover'])
    for (const [state, face] of Object.entries(FACE_OF)) {
      expect(fullBody.has(face), `${state} -> ${face}`).toBe(true)
    }
  })

  it('still tells the states apart without distinct art', () => {
    // The state is what drivers key off — the animation and the bubble wording
    // differ per state even where the drawing cannot.
    const pet = new PetState({ now: fakeClock() })
    const seen = new Set()
    pet.noteEvent(turnStart())
    seen.add(pet.snapshot().state)
    pet.noteEvent(toolCall())
    seen.add(pet.snapshot().state)
    pet.noteEvent(turnEnd('completed'))
    seen.add(pet.snapshot().state)
    pet.noteEvent(turnEnd('error'))
    seen.add(pet.snapshot().state)
    expect(seen).toEqual(new Set([STATES.THINKING, STATES.WORKING, STATES.CELEBRATE, STATES.ERROR]))
  })
})

describe('state frames on the wire', () => {
  it('is one line of JSON that survives the round trip', () => {
    const line = stateCommand({ state: 'working', face: 'chew', tool: { name: 'pwsh' }, busy: true })
    expect(line.startsWith('state:')).toBe(true)
    expect(JSON.parse(line.slice('state:'.length))).toMatchObject({
      state: 'working',
      face: 'chew',
      tool: { name: 'pwsh' },
      busy: true,
    })
  })

  it('is pushed alongside the older busy line, so an old window still works', async () => {
    const sent = []
    const relay = createBusyRelay({ send: (line) => { sent.push(line) }, heartbeatMs: 1e6 })
    relay.note({ id: 'a' }, 'running')
    relay.noteEvent({ type: 'tool/call', data: { name: 'read_file', arguments: '{}' } })

    expect(sent.some((l) => l.startsWith('state:'))).toBe(true)
    expect(sent.some((l) => l === 'busy:1')).toBe(true)
  })

  it('re-states the snapshot on the heartbeat so a late window catches up', async () => {
    const sent = []
    const relay = createBusyRelay({ send: (line) => { sent.push(line) }, heartbeatMs: 20 })
    relay.note({ id: 'a' }, 'running')
    const before = sent.filter((l) => l.startsWith('state:')).length
    relay.start()
    await new Promise((r) => setTimeout(r, 60))
    relay.stop()
    expect(sent.filter((l) => l.startsWith('state:')).length).toBeGreaterThan(before)
  })

  it('stands the pet down when the plugin unloads', async () => {
    const sent = []
    const relay = createBusyRelay({ send: (line) => { sent.push(line) }, heartbeatMs: 1e6 })
    relay.note({ id: 'a' }, 'running')
    relay.stop()
    const last = sent.filter((l) => l.startsWith('state:')).at(-1)
    expect(JSON.parse(last.slice('state:'.length)).state).toBe('idle')
  })
})
