'use strict';

const { randomUUID } = require('node:crypto');

// One chime per device per interval, regardless of its unread message count.
// SQLite timestamps provide restart recovery; no separate audio queue is stored.
function createNotificationReminders({ inbox, deviceIds, canSend, beep, intervalMs = 60000, onError = () => {} }) {
  let timer;
  let running;
  let stopped = false;
  async function run() {
    for (const deviceId of deviceIds()) {
      if (stopped) break;
      try {
        if (!canSend(deviceId)) continue;
        const notification = await inbox.reminderCandidate(deviceId, intervalMs);
        if (!notification || stopped || !canSend(deviceId)) continue;
        // Persist before publication so a restart does not immediately repeat
        // an uncertain in-flight attempt. Fail closed if the marker cannot commit.
        const marked = await inbox.updateBeep(deviceId, notification.id, { status: 'unknown', reason: 'reminder_attempt_started' });
        if (!marked || marked.readAt !== null || stopped || !canSend(deviceId)) continue;
        const result = await beep(deviceId, marked, { attemptId: randomUUID(), reminder: true });
        const status = ['published', 'not_published', 'unknown'].includes(result?.status) ? result.status : 'unknown';
        await inbox.updateBeep(deviceId, marked.id, { status, reason: 'reminder_attempt_finished' });
      } catch { onError(); }
    }
  }
  function tick() {
    if (stopped || !intervalMs) return Promise.resolve();
    if (!running) running = run().finally(() => { running = null; });
    return running;
  }
  return {
    tick,
    start() {
      if (!timer && intervalMs && !stopped) {
        timer = setInterval(() => { void tick(); }, Math.min(5000, intervalMs));
        timer.unref();
        void tick();
      }
    },
    async close() { stopped = true; clearInterval(timer); await running; }
  };
}

module.exports = { createNotificationReminders };
