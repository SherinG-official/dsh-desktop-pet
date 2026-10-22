'use strict';

/** Small shared helpers: paths, sleeping, tolerant file reads. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function appDir() {
  return path.join(dshHome(), 'desktop');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJsonSafe(file) {
  const text = readFileSafe(file);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 1234567 -> "1.23M", 12345 -> "12.3k" */
function compact(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

module.exports = { dshHome, appDir, sleep, readFileSafe, readJsonSafe, compact };
