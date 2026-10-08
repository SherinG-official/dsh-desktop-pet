'use strict';

/**
 * Token metrics straight out of DSH's own session projection cache.
 *
 * The engine keeps one JSON per session under
 * `<dsh home>/storages/session_projcache/sessions/`, and its `tokenUsage` row is
 * exactly what the UI shows: uncached input, output, cache reads/writes, plus the
 * context-pressure reading. Reading those files needs no plugin and no change to
 * the engine, and the numbers are provider-reported rather than estimated.
 */

const fs = require('node:fs');
const path = require('node:path');

const util = require('./util');

const PROJECTION_DIR = ['storages', 'session_projcache', 'sessions'];

/** Brace-matched substring of `"key": { ... }`, tolerant of nesting and strings. */
function extractObject(text, key) {
  const at = text.lastIndexOf(`"${key}"`);
  if (at < 0) return null;

  const open = text.indexOf('{', at);
  if (open < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(open, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Projection rows are envelopes — `{"ver":2,"seq":N,"val":{…}}` — so the payload
 * is unwrapped when present. Returns `null` when the row is absent.
 */
function extractRow(text, key) {
  const row = extractObject(text, key);
  if (!row) return null;
  if (row.val && typeof row.val === 'object') return row.val;
  return row;
}

function numbersOf(source) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function metricTotal(totals) {
  return (totals.uncachedInputTokens || 0)
    + (totals.outputTokens || 0)
    + (totals.cacheReadTokens || 0)
    + (totals.cacheWriteTokens || 0);
}

class Metrics {
  /** @param {{cacheDir?: string}} [options] */
  constructor(options = {}) {
    this.dir = options.cacheDir
      || path.join(util.dshHome(), ...PROJECTION_DIR);
    this.state = Metrics.empty();
  }

  static empty() {
    return {
      at: 0,
      sessions: 0,
      liveSession: null,
      liveTitle: null,
      totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      allTime: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      totalTokens: 0,
      allTimeTokens: 0,
      context: null,
      turns: 0,
      steps: 0,
      updatedAt: 0,
    };
  }

  listSessionFiles() {
    try {
      return fs.readdirSync(this.dir)
        .filter((name) => name.startsWith('session-') && name.endsWith('.json'))
        .map((name) => {
          const full = path.join(this.dir, name);
          let stat;
          try {
            stat = fs.statSync(full);
          } catch {
            return null;
          }
          return { file: full, id: name.replace(/^session-|\.json$/g, ''), mtime: stat.mtimeMs };
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
  }

  /** Re-reads every projection file and recomputes totals. */
  refresh() {
    const files = this.listSessionFiles();
    const state = Metrics.empty();
    state.sessions = files.length;

    let newest = null;
    for (const entry of files) {
      const text = util.readFileSafe(entry.file);
      if (!text) continue;

      const usage = extractRow(text, 'tokenUsage');
      const totals = numbersOf(usage && usage.totals);
      if (Object.keys(totals).length === 0) continue;

      for (const key of Object.keys(state.allTime)) {
        state.allTime[key] += totals[key] || 0;
      }
      if (!newest) {
        newest = { entry, totals };
        state.liveSession = entry.id;
        state.context = numbersOf(extractRow(text, 'contextPressure'));
        const stats = extractRow(text, 'sessionStats');
        state.turns = (stats && stats.turns) || 0;
        state.steps = (stats && stats.steps) || 0;
      }
    }

    if (newest) {
      state.totals = newest.totals;
      state.totalTokens = metricTotal(newest.totals);
      state.liveTitle = this.titleOf(newest.entry.file);
    }
    state.allTimeTokens = metricTotal(state.allTime);
    state.updatedAt = Date.now();
    // Liveness is the newest *file*, not the newest file that carries usage: a
    // brand-new session has no tokenUsage row for its first moments, and picking
    // the newest usage-carrying file then handed "live" to a previous session
    // whose mtime was long dead — so the pet read idle through a whole first turn.
    state.at = files.length > 0 ? files[0].mtime : 0;
    this.state = state;
    return state;
  }

  /** Session title, for the tray tooltip. */
  titleOf(file) {
    const text = util.readFileSafe(file);
    if (!text) return null;
    const match = text.match(/"title"\s*:\s*\{[^}]*?"val"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
    if (!match) return null;
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return null;
    }
  }

  /**
   * True while the newest session file keeps growing (agent likely working).
   *
   * This is a *fallback*: the projection cache is flushed at step boundaries, so
   * a long model call writes nothing for up to ~40 s and this reads idle while
   * the agent is working. The window prefers the host plugin's `agent/status`
   * verdict and only falls back here when no host is talking to it (see
   * `busyNow()` in pet.js).
   */
  isBusy() {
    return this.state.at > 0 && Date.now() - this.state.at < 4000;
  }
}

module.exports = { Metrics, extractObject };
