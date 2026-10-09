'use strict';

function createScreenBreakService({ reminders, deviceIds, allowed, busy, online, tts, send, onEvent = () => {}, setTimer = setInterval, clearTimer = clearInterval }) {
  let timer, running, stopped = false;
  const reported = new Map();
  async function call(deviceId, operation, input = {}) { return reminders.call(deviceId, `screen_${operation}`, input); }
  async function tick() {
    if (stopped) return;
    if (running) return running;
    running = (async () => {
      for (const deviceId of deviceIds()) {
        if (stopped) break;
        if (!allowed(deviceId)) continue;
        try {
          const result = await call(deviceId, 'tick');
          for (const event of result.events) {
            const skip = async reason => { await call(deviceId, 'result', { id: event.id, status: 'skipped', reason }); onEvent('screen_break.skipped', { device_id: deviceId, event_id: event.id, reason }); };
            if (result.quiet) { await skip('quiet_hours'); continue; }
            if (busy(deviceId)) continue; // Wait at most until the persistent event's expiry.
            if (!await online(deviceId)) { await skip('device_offline'); continue; }
            let asset;
            try { asset = await tts.issue(event.kind, result.settings.language, result.settings.rest_minutes); }
            catch { await skip('tts_unavailable'); continue; }
            if (stopped || !allowed(deviceId)) break;
            if (busy(deviceId)) continue;
            if (!await online(deviceId)) { await skip('device_offline'); continue; }
            const claim = await call(deviceId, 'claim', { id: event.id, revision: event.revision });
            if (!claim.allowed) continue;
            // A committed claim is never retried, including an unknown send outcome.
            let delivery;
            try { delivery = await send(deviceId, { audio_url: asset.audio_url, subtitles: [{ start_ms: 0, text: asset.text }], idempotencyKey: `screen-${event.id}`, expiresAt: event.expires_at }); }
            catch { delivery = { status: 'unknown', reason: 'publication_unconfirmed' }; }
            const status = delivery.status === 'published' ? 'published' : delivery.status === 'not_published' ? 'skipped' : 'unknown';
            const reason = status === 'published' ? 'gateway_published' : status === 'skipped' ? 'gateway_not_published' : 'publication_unconfirmed';
            await call(deviceId, 'result', { id: event.id, status, reason });
            onEvent('screen_break.delivery', { device_id: deviceId, event_id: event.id, status, reason, playback: 'unknown' });
          }
        } catch (error) {
          if (Date.now() - (reported.get(deviceId) || 0) >= 60000) {
            if (reported.size >= 256) reported.delete(reported.keys().next().value);
            reported.set(deviceId,Date.now()); onEvent('screen_break.error', { device_id: deviceId, code: error.code || 'UNAVAILABLE' });
          }
        }
      }
    })().finally(() => { running = null; });
    return running;
  }
  return { call, tick, start() { if (!timer && !stopped) { timer = setTimer(() => { void tick(); }, 1000); timer?.unref?.(); void tick(); } },
    async close() { stopped = true; clearTimer(timer); await running; } };
}
module.exports = { createScreenBreakService };
