'use strict';

const { performance } = require('node:perf_hooks');

function validateVoiceIdleSeconds(value) {
  if (!Number.isInteger(value) || value !== 0 && (value < 15 || value > 3600)) {
    throw new RangeError('Standby timeout must be 0 (disabled) or 15–3600 seconds');
  }
  return value;
}
function parseVoiceIdleSeconds(value) {
  if (value === undefined || value === '') return 60;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new TypeError('VOICE_IDLE_TIMEOUT_SECONDS must be an integer');
  return validateVoiceIdleSeconds(Number(value));
}
function resolveVoiceIdleSeconds(value, fallback) {
  if (value === undefined || value === null) return fallback;
  try { return validateVoiceIdleSeconds(value); } catch { return fallback; }
}
function parseVoiceActivityThreshold(value) {
  if (value === undefined || value === '') return 500;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 50 || Number(value) > 10000) {
    throw new RangeError('VOICE_ACTIVITY_THRESHOLD must be an integer between 50 and 10000');
  }
  return Number(value);
}

// Speech inactivity is independent of network activity. PCM is mono signed
// 16-bit LE at 16 kHz. A sustained energy threshold is a simple speech heuristic,
// not a semantic VAD: nearby voices/TV/noise may still count as activity.
class VoiceIdleTimer {
  constructor({ timeoutMs, threshold = 500, onIdle, now = () => performance.now(),
    setTimer = setTimeout, clearTimer = clearTimeout, maxHoldMs = 120000 }) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(threshold) || threshold <= 0 ||
        !Number.isFinite(maxHoldMs) || maxHoldMs <= 0 || typeof onIdle !== 'function') throw new TypeError('Invalid voice idle timer');
    Object.assign(this, { timeoutMs, threshold, onIdle, now, setTimer, clearTimer, maxHoldMs });
    this.started = false;
    this.stopped = false;
    this.holds = new Map();
    this.timer = null;
    this.speechMs = 0;
    this.lastPcmAt = null;
  }
  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.lastActivity = this.now();
    this.schedule();
  }
  activity() {
    if (!this.started || this.stopped) return;
    this.lastActivity = this.now();
    this.schedule();
  }
  hold(key) {
    if (!this.started || this.stopped || !this.timeoutMs) return;
    this.holds.set(key, this.now() + this.maxHoldMs);
    this.activity();
  }
  release(key) {
    if (this.holds.delete(key)) this.activity();
  }
  resume() {
    this.holds.clear();
    this.activity();
  }
  pcm(buffer) {
    if (!this.started || this.stopped || !this.timeoutMs || !Buffer.isBuffer(buffer) || buffer.length < 2 || buffer.length % 2) return false;
    const time = this.now();
    if (this.lastPcmAt === null || time - this.lastPcmAt > 250) this.speechMs = 0;
    this.lastPcmAt = time;
    const count = buffer.length / 2;
    let sum = 0, squares = 0;
    for (let offset = 0; offset < buffer.length; offset += 2) {
      const sample = buffer.readInt16LE(offset);
      sum += sample;
      squares += sample * sample;
    }
    // Ignore a microphone's DC offset rather than treating it as continuous voice.
    const rms = Math.sqrt(Math.max(0, squares / count - (sum / count) ** 2));
    if (rms < this.threshold) { this.speechMs = 0; return false; }
    this.speechMs = Math.min(120, this.speechMs + count / 16);
    if (this.speechMs < 120) return false; // Ignore a short click/single loud frame.
    this.activity();
    return true;
  }
  schedule() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (!this.started || this.stopped || !this.timeoutMs) return;
    const due = this.holds.size ? Math.min(...this.holds.values()) : this.lastActivity + this.timeoutMs;
    this.timer = this.setTimer(() => this.tick(), Math.max(1, due - this.now()));
    this.timer?.unref?.();
  }
  tick() {
    this.timer = null;
    if (this.stopped) return;
    const time = this.now();
    for (const [key, expires] of this.holds) {
      if (expires <= time) { this.holds.delete(key); this.lastActivity = time; }
    }
    if (!this.holds.size && time - this.lastActivity >= this.timeoutMs) {
      this.stop();
      this.onIdle();
      return;
    }
    this.schedule();
  }
  stop() {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.holds.clear();
  }
}

module.exports = { VoiceIdleTimer, validateVoiceIdleSeconds, parseVoiceIdleSeconds, resolveVoiceIdleSeconds, parseVoiceActivityThreshold };
