'use strict';
const { performance } = require('node:perf_hooks');

// In-order audio has no added delay. Only holes wait: 120 -> 240 -> 360 ms,
// recovering one step after ten stable seconds. Packet/range history is bounded.
class UdpJitterBuffer {
  constructor({ onPacket, onGap = () => {}, waitMs = 120, maxWaitMs = 360, maxPackets = 48,
    recoveryMs = 10000, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    if (![waitMs, maxWaitMs, maxPackets, recoveryMs].every(Number.isSafeInteger) || waitMs < 1 ||
      maxWaitMs < waitMs || maxWaitMs > 1000 || maxPackets < 1 || maxPackets > 128 || recoveryMs < 1000) throw new TypeError('Invalid jitter limits');
    Object.assign(this, { onPacket, onGap, waitMs, maxWaitMs, maxPackets, recoveryMs, now, setTimer, clearTimer });
    this.stablePackets = 0; this.minWaitMs = waitMs; this.lastIncreaseAt = -Infinity; this.lastTroubleAt = now();
    this.pending = new Map(); this.next = 1; this.timer = null; this.stopped = false;
    this.endTimer = null; this.ending = null; this.seen = new Set(); this.missingRanges = [];
    this.stats = { received: 0, forwarded: 0, late: 0, stale: 0, duplicates: 0, reordered: 0, recovered: 0,
      missing: 0, untracked_missing: 0, after_stop: 0, max_reorder_wait_ms: 0 };
  }
  trouble() {
    const time = this.now(); this.lastTroubleAt = time; this.stablePackets = 0;
    // A timeout and its subsequent late arrival must not cause two immediate increases.
    if (time - this.lastIncreaseAt < 1000 || this.waitMs >= this.maxWaitMs) return;
    this.waitMs = Math.min(this.maxWaitMs, this.waitMs + this.minWaitMs); this.lastIncreaseAt = time;
    this.armEnd();
  }
  remember(sequence) {
    this.seen.add(sequence);
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value);
  }
  trimHistory() {
    while (this.missingRanges.length > 128) {
      const range = this.missingRanges.shift(); this.stats.untracked_missing += range.end - range.start + 1;
    }
  }
  late(sequence) {
    const index = this.missingRanges.findIndex(range => sequence >= range.start && sequence <= range.end);
    if (index === -1) { this.stats.stale++; return; }
    const range = this.missingRanges[index], replacement = [];
    if (range.start < sequence) replacement.push({ start: range.start, end: sequence - 1 });
    if (sequence < range.end) replacement.push({ start: sequence + 1, end: range.end });
    this.missingRanges.splice(index, 1, ...replacement); this.trimHistory();
    this.stats.late++; this.trouble();
  }
  push(sequence, data) {
    if (this.stopped || !Number.isInteger(sequence) || sequence < 1 || sequence > 0xffffffff) return false;
    this.stats.received++;
    if (this.seen.has(sequence) || this.pending.has(sequence)) { this.stats.duplicates++; return false; }
    if (sequence < this.next) { this.late(sequence); this.remember(sequence); return false; }
    if (!this.pending.size && sequence === this.next) this.stablePackets++;
    if (!this.pending.size && !this.ending && this.stablePackets >= 32 && this.now() - this.lastTroubleAt >= this.recoveryMs) {
      this.waitMs = Math.max(this.minWaitMs, this.waitMs - this.minWaitMs); this.lastTroubleAt = this.now(); this.stablePackets = 0;
    }
    if (sequence !== this.next) this.stats.reordered++;
    else if (this.pending.size) {
      const waited = Math.ceil(this.now() - Math.min(...[...this.pending.values()].map(item => item.at)));
      this.stats.recovered++; this.stats.max_reorder_wait_ms = Math.max(this.stats.max_reorder_wait_ms, waited);
      if (waited >= this.waitMs * 0.75) this.trouble();
    }
    // Include the incoming packet before flushing, even if it closes an earlier
    // part of the hole. Otherwise capacity pressure itself could discard it.
    const force = this.pending.size >= this.maxPackets && sequence !== this.next;
    this.pending.set(sequence, { data, at: this.now() }); this.drain(force);
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
        this.missingRanges.push({ start: this.next, end: lowest - 1 }); this.trimHistory();
        this.next = lowest; this.stats.missing += missing;
        if (!force) this.trouble();
        this.onGap(missing);
        if (this.stopped) return;
      }
      const sequence = this.next++;
      const item = this.pending.get(sequence); this.pending.delete(sequence);
      this.stats.forwarded++; this.remember(sequence); this.onPacket(item.data, sequence);
    }
  }
  // MQTT listen-stop may overtake UDP audio. Keep one bounded deadline, extending
  // it if adaptation rises while waiting; repeated stops cannot prolong it.
  requestEnd(callback) {
    if (this.stopped || this.ending) return;
    this.ending = { at: this.now(), callback }; this.armEnd();
  }
  armEnd() {
    if (!this.ending || this.stopped) return;
    if (this.endTimer !== null) this.clearTimer(this.endTimer);
    const remaining = Math.max(0, this.ending.at + this.waitMs - this.now());
    this.endTimer = this.setTimer(() => {
      const end = this.ending; this.ending = null; this.endTimer = null;
      this.flush();
      if (!this.stopped) end.callback();
    }, remaining);
    this.endTimer?.unref?.();
  }
  cancelEnd() {
    if (this.endTimer !== null) this.clearTimer(this.endTimer);
    this.endTimer = null; this.ending = null;
  }
  flush() { this.drain(true); }
  snapshot() {
    return { ...this.stats, pending: this.pending.size, wait_ms: this.waitMs,
      unrecovered: this.stats.missing - this.stats.late };
  }
  stop() {
    this.stopped = true; this.cancelEnd();
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null; this.pending.clear(); this.seen.clear(); this.missingRanges = [];
  }
}
module.exports = { UdpJitterBuffer };
