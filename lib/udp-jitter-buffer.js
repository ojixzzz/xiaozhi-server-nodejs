'use strict';
const { performance } = require('node:perf_hooks');

// Contiguous packets pass immediately. Wait at most 120 ms for a missing
// sequence, with a bounded window; duplicates/replays never reach the decoder.
class UdpJitterBuffer {
  constructor({ onPacket, onGap = () => {}, waitMs = 120, maxPackets = 32,
    now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { onPacket, onGap, waitMs, maxPackets, now, setTimer, clearTimer });
    this.pending = new Map(); this.next = 1; this.timer = null; this.stopped = false;
    this.stats = { received: 0, forwarded: 0, late: 0, duplicates: 0, reordered: 0, missing: 0 };
  }
  push(sequence, data) {
    if (this.stopped || !Number.isInteger(sequence) || sequence < 1 || sequence > 0xffffffff) return false;
    this.stats.received++;
    if (sequence < this.next) { this.stats.late++; return false; }
    if (this.pending.has(sequence)) { this.stats.duplicates++; return false; }
    if (sequence !== this.next) this.stats.reordered++;
    if (this.pending.size >= this.maxPackets) this.flush();
    if (this.stopped || sequence < this.next) { this.stats.late++; return false; }
    this.pending.set(sequence, { data, at: this.now() }); this.drain();
    return true;
  }
  drain(force = false) {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    while (!this.stopped && this.pending.size) {
      if (!this.pending.has(this.next)) {
        const lowest = Math.min(...this.pending.keys());
        const oldest = Math.min(...[...this.pending.values()].map(item => item.at));
        const remaining = this.waitMs - (this.now() - oldest);
        if (!force && remaining > 0) {
          this.timer = this.setTimer(() => { this.timer = null; this.drain(); }, remaining);
          this.timer?.unref?.(); return;
        }
        const missing = lowest - this.next;
        this.next = lowest; this.stats.missing += missing; this.onGap(missing);
        if (this.stopped) return;
      }
      const sequence = this.next++;
      const item = this.pending.get(sequence); this.pending.delete(sequence);
      this.stats.forwarded++; this.onPacket(item.data, sequence);
    }
  }
  flush() { this.drain(true); }
  snapshot() { return { ...this.stats, pending: this.pending.size }; }
  stop() {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null; this.pending.clear();
  }
}
module.exports = { UdpJitterBuffer };
