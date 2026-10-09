'use strict';
const { performance } = require('node:perf_hooks');

function transientError(error) {
  for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
      'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(cause.code)) return true;
    if ([408, 429, 500, 502, 503, 504].includes(Number(cause.status ?? cause.code))) return true;
    if (/fetch failed|network error|socket hang up|connection reset|timed? ?out/i.test(cause.message || '')) return true;
  }
  return false;
}

class LiveRecovery {
  constructor({ now = () => performance.now(), delays = [1000, 2000, 4000, 8000, 15000], stableMs = 30000 } = {}) {
    Object.assign(this, { now, delays, stableMs }); this.attempts = 0; this.readyAt = null;
  }
  connected() { this.readyAt = this.now(); }
  next(details = {}) {
    if (this.readyAt !== null && this.now() - this.readyAt >= this.stableMs) this.attempts = 0;
    this.readyAt = null;
    const transient = details.retryable === true || details.retryable !== false &&
      (details.code === undefined || [1000, 1001, 1006, 1011, 1012, 1013].includes(details.code));
    if (!transient || this.attempts >= this.delays.length) return null;
    return { retry: ++this.attempts, delayMs: this.delays[this.attempts - 1] };
  }
}

module.exports = { LiveRecovery, transientError };
