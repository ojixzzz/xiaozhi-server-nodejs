'use strict';
const { performance } = require('node:perf_hooks');
const COUNTERS = ['received','forwarded','missing','late','stale','duplicates','reordered','recovered','after_stop','untracked_missing'];
const empty = () => ({ gaps: 0, missing_frames: 0, missing_audio_ms: 0, concealed_frames: 0, concealed_audio_ms: 0 });

// No audio contents or per-packet timers: one bounded summary window per session.
function createAudioInputDiagnostics({ trace, now = () => performance.now(), setTimer = setInterval, clearTimer = clearInterval }) {
  let window = empty(), stats = null, previous = {}, start = now(), statsAt = null, stopped = false;
  function flush(reason = 'interval') {
    const delta = {};
    for (const field of COUNTERS) if (stats && Number.isSafeInteger(stats[field])) {
      delta[field] = Math.max(0, stats[field] - (previous[field] || 0));
    }
    if (window.gaps || Object.values(delta).some(value => value > 0)) {
      trace.event('audio.input_summary', { reason, window_ms: Math.round(now() - start), ...window,
        ...(stats ? { udp: { ...stats }, udp_delta: delta, udp_age_ms: Math.round(now() - statsAt) } : {}) }, window.gaps || delta.missing > 0 ? 'warn' : 'info');
    }
    previous = stats ? { ...stats } : previous; window = empty(); start = now();
  }
  const timer = setTimer(() => flush(), 5000); timer?.unref?.();
  return {
    gap(frames, duration, concealed) {
      if (stopped || !frames) return;
      window.gaps++; window.missing_frames += frames; window.missing_audio_ms += frames * duration;
      window.concealed_frames += concealed; window.concealed_audio_ms += concealed * duration;
      trace.event('audio.input_gap', { frames, frame_duration: duration, concealed_frames: concealed }, 'debug');
    },
    transport(value) { if (!stopped) { stats = { ...value }; statsAt = now(); } },
    stop() { if (stopped) return; stopped = true; clearTimer(timer); flush('session_closed'); }
  };
}
module.exports = { createAudioInputDiagnostics };
