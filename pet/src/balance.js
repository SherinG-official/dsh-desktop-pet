'use strict';

/**
 * DeepSeek account balance, from the officially documented public endpoint:
 *   GET https://api.deepseek.com/user/balance
 *   { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 *
 * The API key is read from the same credential store the engine uses
 * (`<dsh home>/.credentials.yaml`); it is never logged and never leaves this process.
 */

const fs = require('node:fs');
const path = require('node:path');

const util = require('./util');

const ENDPOINT = 'https://api.deepseek.com/user/balance';
const DEFAULT_INTERVAL_MS = 60000;

/** Reads DEEPSEEK_API_KEY out of the credential store without logging it. */
function readApiKey() {
  const file = path.join(util.dshHome(), '.credentials.yaml');
  const text = util.readFileSafe(file);
  if (!text) return null;
  const match = text.match(/DEEPSEEK_API_KEY:\s*['"]?([A-Za-z0-9._-]{10,})['"]?/);
  return match ? match[1] : null;
}

class Balance {
  /**
   * @param {{intervalMs?: number, onUpdate?: (state: object) => void}} [options]
   */
  constructor(options = {}) {
    this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
    this.onUpdate = options.onUpdate || (() => {});
    this.timer = null;
    this.state = {
      ok: false,
      reason: null,
      currency: null,
      total: null,
      granted: null,
      toppedUp: null,
      available: null,
      fetchedAt: 0,
      error: null,
    };
  }

  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh() {
    const key = readApiKey();
    if (!key) {
      this.update({ ok: false, reason: 'no-key', error: '凭据里没有 DEEPSEEK_API_KEY' });
      return this.state;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(ENDPOINT, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.status === 401 || response.status === 403) {
        this.update({ ok: false, reason: 'bad-key', error: `HTTP ${response.status}：密钥无效` });
        return this.state;
      }
      if (!response.ok) {
        this.update({ ok: false, reason: 'http', error: `HTTP ${response.status}` });
        return this.state;
      }

      const body = await response.json();
      const info = Array.isArray(body.balance_infos) && body.balance_infos.length > 0
        ? body.balance_infos[0]
        : null;

      if (!info) {
        this.update({ ok: false, reason: 'shape', error: '响应里没有 balance_infos' });
        return this.state;
      }

      this.update({
        ok: true,
        reason: null,
        error: null,
        available: body.is_available !== false,
        currency: info.currency || 'CNY',
        total: Number(info.total_balance),
        granted: Number(info.granted_balance),
        toppedUp: Number(info.topped_up_balance),
        fetchedAt: Date.now(),
      });
    } catch (error) {
      const aborted = error && error.name === 'AbortError';
      this.update({
        ok: false,
        reason: aborted ? 'timeout' : 'network',
        error: aborted ? '请求超时' : `网络错误：${error.message}`,
      });
    }
    return this.state;
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    try {
      this.onUpdate(this.state);
    } catch {
      /* listeners must never break polling */
    }
  }

  /** "¥102.33" (or "$…"), "—" while unknown. */
  get display() {
    const { ok, currency, total } = this.state;
    if (!ok || !Number.isFinite(total)) return '—';
    const symbol = currency === 'USD' ? '$' : '¥';
    return `${symbol}${total.toFixed(2)}`;
  }
}

module.exports = { Balance, readApiKey, ENDPOINT };
