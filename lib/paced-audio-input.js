'use strict';
const { performance } = require('node:perf_hooks');

// PCM16 mono at 16 kHz, sent in 20 ms frames. Only unsent audio is buffered;
// audio already submitted to the provider is never replayed on reconnect.
class PacedAudioInput {
  constructor({ send, end, ready, onDrop = () => {}, onEnd = () => {}, now = () => performance.now(),
    setTimer = setInterval, clearTimer = clearInterval, maxAgeMs = 3000, silenceMs = 1200 }) {
    Object.assign(this, { send, end, ready, onDrop, onEnd, now, setTimer, clearTimer, maxAgeMs, silenceMs });
    this.frames = []; this.partial = Buffer.alloc(0); this.timer = null; this.active = false;
    this.endRequested = false; this.stopped = false; this.lastInputAt = 0;
  }
  get length() { return this.frames.length; }
  push(pcm) {
    if (this.stopped || !pcm.length) return;
    this.lastInputAt = this.now(); this.active = true; this.endRequested = false;
    const bytes = Buffer.concat([this.partial, pcm]);
    let offset = 0;
    while (offset + 640 <= bytes.length) {
      this.frames.push({ data: Buffer.from(bytes.subarray(offset, offset + 640)), at: this.lastInputAt }); offset += 640;
    }
    this.partial = Buffer.from(bytes.subarray(offset));
    this.trim(); this.start();
  }
  trim() {
    let dropped = 0;
    while (this.frames.length && (this.frames.length > 150 || this.now() - this.frames[0].at > this.maxAgeMs)) {
      this.frames.shift(); dropped++;
    }
    if (dropped) this.onDrop(dropped);
  }
  requestEnd() {
    if (!this.active || this.stopped) return;
    this.endRequested = true;
    if (this.partial.length) {
      const data = Buffer.alloc(640); this.partial.copy(data);
      this.frames.push({ data, at: this.lastInputAt }); this.partial = Buffer.alloc(0);
    }
    this.start();
  }
  start() {
    if (this.timer !== null || this.stopped) return;
    this.timer = this.setTimer(() => this.tick(), 20); this.timer?.unref?.();
  }
  tick() {
    if (this.stopped) return;
    this.trim();
    if (this.active && !this.endRequested && this.now() - this.lastInputAt >= this.silenceMs) this.requestEnd();
    if (!this.ready()) return;
    if (this.frames.length) {
      const frame = this.frames[0];
      if (this.send(frame.data) !== false && this.frames[0] === frame) this.frames.shift();
      return;
    }
    if (this.active && this.endRequested && this.end() !== false) {
      this.active = false; this.endRequested = false; this.onEnd();
      this.clearTimer(this.timer); this.timer = null;
    }
  }
  clear() {
    this.frames = []; this.partial = Buffer.alloc(0); this.active = false; this.endRequested = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
  stop() { this.clear(); this.stopped = true; }
}
module.exports = { PacedAudioInput };
