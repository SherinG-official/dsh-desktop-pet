/**
 * The mascot's state machine, as pure logic.
 *
 * This is the piece that decides *what the pet is doing right now* from what the
 * engine is doing right now — and it deliberately knows nothing about Electron,
 * sockets or the DOM, so it can be driven event by event in a test.
 *
 * Why it exists
 * -------------
 * 0.3.1 got the pet to chew while the agent works, but "working" was the whole
 * vocabulary: it could not rest, could not celebrate, could not show that it was
 * waiting on a model instead of on a shell command, and could not look like it
 * was doing anything at all when nothing was happening. Every comparable pet
 * gives the character more than one bit of state (see docs/pet-v2-design.md for
 * the survey), and this module is that state, kept honest by the engine's own
 * events rather than by guesswork.
 *
 * The signals, and why each one
 * -----------------------------
 *   turn/start        a turn opened — the model is about to think
 *   tool/call         the model asked for a tool: this is the first moment the
 *                     pet can say *what* is happening, since `arguments` is the
 *                     raw JSON the model produced
 *   tool/result       a tool finished; `error` present means it failed
 *   turn/end          the turn closed, with a `reason` that says whether it
 *                     actually succeeded
 *   agent/status      fallback liveness (`running` / `idle`) for anything the
 *                     session events above do not cover
 *
 * `turn/end`'s reason is the interesting one. A turn can end `completed`,
 * `aborted`, `blocked`, `error`, `max-tokens` or `interrupted`, and celebrating
 * an `aborted` turn — the user pressed stop — would be tone-deaf. Only
 * `completed` celebrates; `error` frowns; everything else just goes quiet.
 *
 * Fallback behaviour
 * ------------------
 * When the host stops talking (plugin unloaded, desktop app closed) the caller
 * tells us with `degrade()`, and the machine drops back to the two states the
 * window can still justify from the projection cache: idle and working. It must
 * never invent a celebration or an error it cannot see.
 */

// ESM on purpose: this lives beside lib/index.js, which the harness imports.
// (`src/` carries its own `{"type":"commonjs"}` package.json for the window
// process; a CommonJS file here would not be importable from the plugin.)

/**
 * How long a celebration or a frown holds before the pet goes back to resting.
 * These are transitions the pet times itself — the engine has nothing more to
 * say after a turn ends.
 */
export const CELEBRATE_MS = 3000;
export const ERROR_MS = 4000;

/**
 * The states, and what each one means for the drawing.
 *
 * `chew` is the only one that animates a mouth; the others are whole-face art
 * plus (for thinking/sleep) a CSS treatment. Named for what the agent is doing,
 * not for the art, so swapping art later does not rename the state machine.
 */
export const STATES = {
  IDLE: 'idle',
  THINKING: 'thinking',
  WORKING: 'working',
  CELEBRATE: 'celebrate',
  ERROR: 'error',
  SLEEP: 'sleep',
};

/**
 * Which face art a state draws with.
 *
 * This mapping is constrained by what the art pack actually contains, which is
 * not six expressions. Measured (see docs/pet-v2-design.md §13):
 *
 *   base / chew / hover   ~397x420, aspect 0.95, 72% opaque  — the full-body set
 *   idle / busy / alert   256x256, aspect 1.00, 77% opaque    — SQUARE AVATARS
 *   mini (page button)    96x96,  aspect 1.00, 78% opaque
 *
 * `idle` / `busy` / `alert` are the same square family as `mini`: they are
 * portrait crops of the same winking face (differing mainly by a "Deepseek"
 * banner), not full-body poses. Drawing one into the mascot's slot fills the
 * window with a floating head, and two of them show a branded title card — so
 * they are unusable as expressions, however tempting the filenames are.
 *
 * Until real expression art exists, every state maps onto the three full-body
 * drawings, and the *state* is carried by the animation (see renderer/pet.css)
 * plus the bubble's wording. That is a deliberate, honest limit: a state machine
 * that shows the same face six ways is still far more legible than one that
 * flashes a logo.
 */
export const FACE_OF = {
  [STATES.IDLE]: 'base',
  [STATES.THINKING]: 'base',
  [STATES.WORKING]: 'chew',
  [STATES.CELEBRATE]: 'hover',
  [STATES.ERROR]: 'base',
  [STATES.SLEEP]: 'base',
};

/** `turn/end` reason kinds that mean the work actually finished. */
const SUCCESS_REASONS = new Set(['completed']);

/** `turn/end` reason kinds that mean something went wrong. */
const FAILURE_REASONS = new Set(['error']);

export class PetState {
  /**
   * @param {{celebrateMs?: number, errorMs?: number, sleepAfterMs?: number, now?: () => number}} [options]
   *   `now` is injectable so the timing rules can be tested without waiting.
   */
  constructor(options = {}) {
    this.celebrateMs = options.celebrateMs ?? CELEBRATE_MS;
    this.errorMs = options.errorMs ?? ERROR_MS;
    this.sleepAfterMs = options.sleepAfterMs ?? 180_000;
    this.now = options.now ?? (() => Date.now());

    /** Agents currently `running`, by id: the flag is "any of them". */
    this.running = new Set();
    /** Turn number of the turn currently open, or null. */
    this.turn = null;
    this.step = null;
    this.state = STATES.IDLE;
    /** The tool the pet is currently showing, or null. */
    this.tool = null;
    /** Steps completed in this turn, for a "N done" readout. */
    this.stepsDone = 0;
    /** When the current state was entered. */
    this.since = this.now();
    /** When the last turn event arrived, for the sleep timer. */
    this.lastActivityAt = this.now();
    /** Set by degrade(): the host is gone, so only idle/working are trusted. */
    this.degraded = false;
    /** A timed state (celebrate/error) that expires on its own. */
    this.until = 0;
  }

  /** True while the agent is running, by the engine's own reckoning. */
  isBusy() {
    return this.running.size > 0;
  }

  /**
   * Moves to `state` unless it is already there.
   *
   * `holdMs` gives a state a lifetime; `expire()` is what the caller's timer
   * uses to come back. Returns true when the state actually changed.
   */
  enter(state, holdMs = 0) {
    const now = this.now();
    // Re-entering the same state refreshes its hold rather than restarting it:
    // a burst of tool calls should not keep re-triggering a celebration.
    if (state === this.state) {
      if (holdMs > 0) this.until = now + holdMs;
      return false;
    }
    this.state = state;
    this.since = now;
    this.until = holdMs > 0 ? now + holdMs : 0;
    return true;
  }

  /**
   * Ends a timed state if its hold has run out. The caller drives this from the
   * pet's existing 5 s poll, which is why it is a method and not a timer: the
   * window already has a heartbeat, and a second scheduler would be one more
   * thing to keep in step.
   */
  expire() {
    if (this.until > 0 && this.now() >= this.until) {
      this.until = 0;
      return this.settle();
    }
    return false;
  }

  /**
   * True when the pet is resting and has been resting long enough to sleep.
   *
   * Idleness is not an event — nothing arrives to say "still nothing has
   * happened" — so it can only be noticed when someone asks. `snapshot()` is
   * that ask, which means a renderer polling for state is also what lets the pet
   * fall asleep.
   */
  sleepDue() {
    if (this.degraded) return false;                 // not the pet's call to make
    if (this.sleepAfterMs <= 0) return false;
    if (this.state !== STATES.IDLE && this.state !== STATES.SLEEP) return false;
    if (this.isBusy() || this.turn !== null) return false;
    return this.now() - this.lastActivityAt >= this.sleepAfterMs;
  }

  /** Where the pet rests when nothing else is happening: asleep, or idle. */
  settle() {
    const idleFor = this.now() - this.lastActivityAt;
    const asleep = this.sleepAfterMs > 0 && idleFor >= this.sleepAfterMs;
    return this.enter(asleep ? STATES.SLEEP : STATES.IDLE);
  }

  /**
   * An agent entered `running` or went back to `idle`.
   *
   * Status is the coarse signal and the session events are the fine ones, so
   * this only moves the state when it has nothing better to say: a `running`
   * agent whose turn has not opened yet is still doing *something* (it is about
   * to think), and an agent going idle while a turn is somehow still open must
   * not leave the pet chewing forever.
   */
  noteStatus(agentId, status) {
    const id = agentId == null ? null : String(agentId);
    if (id === null) return false;
    if (status === 'running') {
      this.running.add(id);
      // No open turn means no session event has arrived yet: reflect the truth
      // we do have rather than sitting on a stale idle.
      if (this.turn === null && !this.degraded) this.enter(STATES.THINKING);
      return true;
    }
    this.running.delete(id);
    // Everything has stopped: let the pet settle even if a turn/end never came
    // (a crashed or cancelled run can leave the log without its closer).
    if (!this.isBusy() && !this.degraded && this.turn === null) this.settle();
    return true;
  }

  /** An agent left the registry: it will never report `idle` on its own. */
  forget(agentId) {
    const id = agentId == null ? null : String(agentId);
    if (id === null) return false;
    return this.running.delete(id);
  }

  /**
   * One session event. This is the pet's main input.
   *
   * Unknown event types are ignored on purpose: the session log grows new ones
   * over time, and a pet that throws on an unfamiliar event would take the
   * harness down with it.
   */
  noteEvent(event) {
    const type = event && event.type;
    const data = (event && event.data) || {};
    if (!type) return false;

    // Any event at all counts as "something happened", which is what keeps the
    // sleep timer honest.
    this.lastActivityAt = this.now();

    switch (type) {
      case 'turn/start':
        this.turn = data.turn ?? this.turn;
        this.step = null;
        this.tool = null;
        this.stepsDone = 0;
        this.until = 0;
        return this.enter(STATES.THINKING);

      case 'step/start':
        this.step = data.step ?? this.step;
        // A new step means another model call is being composed: back to
        // thinking, even though the previous step ended in a tool call.
        return this.enter(STATES.THINKING);

      case 'step/end':
        if (typeof data.step === 'number') this.step = data.step;
        this.stepsDone += 1;
        return false;

      case 'tool/call':
        this.tool = data.name
          ? { name: String(data.name), callId: data.callId ?? null, arguments: typeof data.arguments === 'string' ? data.arguments : '' }
          : this.tool;
        return this.enter(STATES.WORKING);

      case 'tool/result':
        this.tool = null;
        // A failed tool is not a failed turn: the model often recovers, and the
        // turn's own reason is the authority on whether the work succeeded.
        return false;

      case 'turn/end':
        this.turn = null;
        this.tool = null;
        return this.finish(data.reason);

      default:
        return false;
    }
  }

  /** Turn closed: the reason decides whether the pet cheers, frowns or shrugs. */
  finish(reason) {
    const kind = reason && reason.kind;
    if (this.degraded) return this.settle();
    if (SUCCESS_REASONS.has(kind)) return this.enter(STATES.CELEBRATE, this.celebrateMs);
    if (FAILURE_REASONS.has(kind)) return this.enter(STATES.ERROR, this.errorMs);
    // aborted / blocked / max-tokens / interrupted: the user stopped it, it is
    // waiting on a human, or it was cut off. None of those deserve applause.
    return this.settle();
  }

  /** An agent reported an error outside a turn. */
  noteError() {
    if (this.degraded) return false;
    return this.enter(STATES.ERROR, this.errorMs);
  }

  /**
   * The host went quiet: stop trusting anything richer than busy/idle.
   *
   * The window's projection-cache fallback can tell "it is working" but cannot
   * tell a successful turn from an aborted one, so the whole timed vocabulary is
   * dropped rather than guessed at.
   */
  degrade(busy) {
    this.degraded = true;
    this.tool = null;
    this.turn = null;
    return this.enter(busy ? STATES.WORKING : STATES.IDLE);
  }

  /** The host is talking again. */
  restore() {
    this.degraded = false;
  }

  /** The snapshot the renderer draws from. */
  snapshot() {
    // A timed state that has run out is reported as already settled, so a
    // renderer that polls faster than the pet's own timer never sees a stale
    // celebration.
    if (this.until > 0 && this.now() >= this.until) this.expire();

    // Sleeping is the other direction in time: nothing arrives to announce it,
    // so the reading itself is what lets the pet nod off.
    if (this.state === STATES.IDLE && this.sleepDue()) {
      this.enter(STATES.SLEEP);
    } else if (this.state === STATES.SLEEP && !this.sleepDue()) {
      // Woken by a new turn (or by the nap being switched off).
      this.enter(STATES.IDLE);
    }

    return {
      state: this.state,
      face: FACE_OF[this.state] || 'idle',
      tool: this.tool ? { name: this.tool.name } : null,
      step: this.step,
      stepsDone: this.stepsDone,
      turn: this.turn,
      busy: this.isBusy(),
      since: this.since,
      degraded: this.degraded,
    };
  }
}
