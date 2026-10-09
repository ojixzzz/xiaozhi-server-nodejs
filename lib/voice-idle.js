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
// 16-bit LE at 16 kHz. Compare energy with a rolling background estimate.
// This is not semantic VAD: nearby voices/TV may still count as activity.
class VoiceIdleTimer {
  constructor({ timeoutMs, threshold = 500, onIdle, now = () => performance.now(),
    setTimer = setTimeout, clearTimer = clearTimeout, maxHoldMs = 120000, onEvent = () => {} }) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(threshold) || threshold <= 0 ||
        !Number.isFinite(maxHoldMs) || maxHoldMs <= 0 || typeof onIdle !== 'function') throw new TypeError('Invalid voice idle timer');
    Object.assign(this, { timeoutMs, threshold, onIdle, now, setTimer, clearTimer, maxHoldMs, onEvent });
    this.started = false;
    this.stopped = false;
    this.holds = new Map();
    this.timer = null;
    this.speechMs = 0;
    this.lastPcmAt = null;
    this.energyWindow = [];
    this.energyWindowMs = 0;
    this.rms = 0;
    this.noiseFloor = 0;
    this.effectiveThreshold = threshold;
  }
  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.lastActivity = this.now();
    this.schedule();
    this.onEvent('idle.started', this.snapshot());
  }
  activity() {
    if (!this.started || this.stopped) return;
    this.lastActivity = this.now();
    this.schedule();
  }
  hold(key) {
    if (!this.started || this.stopped || !this.timeoutMs) return;
    const added = !this.holds.has(key);
    this.holds.set(key, this.now() + this.maxHoldMs);
    this.activity();
    if (added) this.onEvent('idle.hold', { key, ...this.snapshot() });
  }
  release(key) {
    if (this.holds.delete(key)) {
      this.activity();
      this.onEvent('idle.release', { key, ...this.snapshot() });
    }
  }
  resume() {
    if (!this.started || this.stopped) return;
    this.holds.clear();
    this.activity();
    this.onEvent('idle.resumed', this.snapshot());
  }
  pcm(buffer) {
    if (!this.started || this.stopped || !this.timeoutMs || !Buffer.isBuffer(buffer) || buffer.length < 2 || buffer.length % 2) return false;
    const time = this.now();
    if (this.lastPcmAt === null || time - this.lastPcmAt > 250) this.speechMs = 0;
    if (this.lastPcmAt !== null && time - this.lastPcmAt > 2000) {
      this.energyWindow = [];
      this.energyWindowMs = 0;
    }
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
    this.rms = rms;
    // Use the lower fifth of the last two seconds, weighted by audio duration,
    // so a short loud sound does not immediately raise the background estimate.
    // Sustained fan/microphone noise settles into the floor after calibration.
    const duration = Math.min(120, count / 16);
    this.energyWindow.push({ rms, duration });
    this.energyWindowMs += duration;
    while (this.energyWindowMs > 2000 || this.energyWindow.length > 256) {
      const oldest = this.energyWindow[0];
      const removed = this.energyWindow.length > 256 ? oldest.duration : Math.min(oldest.duration, this.energyWindowMs - 2000);
      oldest.duration -= removed;
      this.energyWindowMs -= removed;
      if (oldest.duration <= 0) this.energyWindow.shift();
    }
    this.noiseFloor = 0;
    if (this.energyWindowMs >= 500) {
      let accumulated = 0;
      for (const frame of [...this.energyWindow].sort((a, b) => a.rms - b.rms)) {
        accumulated += frame.duration;
        if (accumulated >= this.energyWindowMs * 0.2) { this.noiseFloor = frame.rms; break; }
      }
    }
    this.effectiveThreshold = Math.max(this.threshold, this.noiseFloor * 2.5);
    if (rms < this.effectiveThreshold) { this.speechMs = 0; return false; }
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
      if (expires <= time) {
        this.holds.delete(key); this.lastActivity = time;
        this.onEvent('idle.hold_expired', { key, ...this.snapshot() });
      }
    }
    if (!this.holds.size && time - this.lastActivity >= this.timeoutMs) {
      this.onEvent('idle.timeout', this.snapshot());
      this.stop();
      this.onIdle();
      return;
    }
    this.schedule();
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.onEvent('idle.stopped', this.snapshot());
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.holds.clear();
  }
  snapshot() {
    const idleMs = this.started ? Math.max(0, this.now() - this.lastActivity) : 0;
    return { timeout_ms: this.timeoutMs, idle_ms: Math.round(idleMs),
      remaining_ms: this.timeoutMs ? Math.round(Math.max(0, this.timeoutMs - idleMs)) : null,
      paused: this.holds.size > 0, holds: [...this.holds.keys()],
      hold_remaining_ms: Object.fromEntries([...this.holds].map(([key, expires]) => [key, Math.round(Math.max(0, expires - this.now()))])),
      audio_activity: { rms: Math.round(this.rms), noise_floor: Math.round(this.noiseFloor),
        threshold: Math.round(this.effectiveThreshold), calibrated: this.energyWindowMs >= 500 },
      started: this.started, stopped: this.stopped };
  }
}

module.exports = { VoiceIdleTimer, validateVoiceIdleSeconds, parseVoiceIdleSeconds, resolveVoiceIdleSeconds, parseVoiceActivityThreshold };
