'use strict';

const { performance } = require('node:perf_hooks');

// Network liveness is independent of microphone activity and standby settings.
function startSocketHeartbeat(ws, { intervalMs = 5000, timeoutMs = 30000,
  now = () => performance.now(), setTimer = setInterval, clearTimer = clearInterval,
  onTimeout, onEvent = () => {} } = {}) {
  let lastPongAt = now();
  let pongReceived = false;
  let stopped = false;
  let timer;
  const snapshot = () => ({ interval_ms: intervalMs, timeout_ms: timeoutMs,
    last_pong_age_ms: Math.round(Math.max(0, now() - lastPongAt)), pong_received: pongReceived, stopped });
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimer(timer);
    ws.removeListener('pong', pong);
    ws.removeListener('close', stop);
  }
  function fail(reason, error) {
    if (stopped) return;
    stop();
    onEvent(reason === 'device_heartbeat_timeout' ? 'device.heartbeat_timeout' : 'device.heartbeat_error',
      { ...snapshot(), error }, 'warn');
    onTimeout(reason);
  }
  function pong() {
    if (stopped) return;
    lastPongAt = now();
    pongReceived = true;
    onEvent('device.heartbeat_pong', snapshot(), 'debug');
  }
  function tick() {
    if (stopped) return;
    if (ws.readyState !== 1) { stop(); return; } // WebSocket.OPEN
    if (now() - lastPongAt >= timeoutMs) { fail('device_heartbeat_timeout'); return; }
    try {
      ws.ping(undefined, undefined, error => { if (error) fail('device_heartbeat_send_failed', error); });
    } catch (error) { fail('device_heartbeat_send_failed', error); }
  }
  ws.on('pong', pong);
  ws.on('close', stop);
  timer = setTimer(tick, intervalMs);
  timer?.unref?.();
  onEvent('device.heartbeat_started', snapshot());
  return { stop, snapshot };
}

module.exports = { startSocketHeartbeat };
