'use strict';

const { object } = require('./reminder-calendar');
const { randomUUID } = require('node:crypto');
function createReminderService({ inbox, defaultOffset = 420, deviceIds, allowed, beep, onEvent = () => {}, setTimer = setInterval, clearTimer = clearInterval }) {
  let timer, running, stopped = false;
  const lastReported = new Map();
  function report(event, fields) {
    const key = `${event}:${fields.device_id}:${fields.code || ''}`;
    const now = Date.now();
    if (!lastReported.has(key) || now - lastReported.get(key) >= 60000) {
      if (lastReported.size >= 256) lastReported.delete(lastReported.keys().next().value);
      lastReported.set(key, now); onEvent(event, fields);
    }
  }
  async function call(deviceId, operation, input = {}) {
    if (!allowed(deviceId)) throw Object.assign(new Error('Approved device with dedicated token required'), { code: 'REMINDER_FORBIDDEN' });
    const result = await inbox.reminders(deviceId, operation, input, defaultOffset);
    if (!['list','get','history','settings_get','can_beep','tick','agenda','calendar','trace','screen_get','screen_history','screen_tick','screen_claim','screen_result'].includes(operation)) {
      onEvent('reminder.changed', { device_id: deviceId, operation, reminder_id: result.reminder?.id, occurrence_id: result.occurrence?.id });
    }
    return result;
  }
  async function tick() {
    if (stopped) return;
    if (running) return running;
    running = (async () => {
      for (const deviceId of deviceIds()) {
        if (stopped) break;
        if (!allowed(deviceId)) continue;
        try {
          const result = await call(deviceId, 'tick');
          if (result.deferred.length) report('reminder.capacity_deferred', { device_id: deviceId, count: result.deferred.length });
          // One immediate chime per device for this batch; unread repeats are shared.
          for (const notification of result.notifications) {
            onEvent('reminder.due', { device_id: deviceId, notification_id: notification.id });
          }
          const notification = result.notifications[0];
          if (notification && !stopped && allowed(deviceId)) {
            await inbox.updateBeep(deviceId, notification.id, { status: 'unknown', reason: 'scheduled_attempt_started' });
            const result = await beep(deviceId, notification, { reminder: true, attemptId: randomUUID() });
            await inbox.updateBeep(deviceId, notification.id, { status: ['published','not_published','unknown'].includes(result?.status) ? result.status : 'unknown', reason: result?.reason || 'scheduled_reminder' });
          }
        } catch (error) { report('reminder.error', { device_id: deviceId, code: error.code || 'REMINDER_UNAVAILABLE' }); }
      }
    })().finally(() => { running = null; });
    return running;
  }
  return { call, tick,
    start() { if (!timer && !stopped) { timer = setTimer(() => { void tick(); }, 1000); timer?.unref?.(); void tick(); } },
    async close() { stopped = true; clearTimer(timer); await running; }
  };
}
function statusFor(error) {
  return error instanceof TypeError || error instanceof RangeError ? 400 : error.code === 'REMINDER_NOT_FOUND' ? 404 :
    error.code === 'REMINDER_FORBIDDEN' ? 403 : error.code === 'REMINDER_CONFLICT' ? 409 : ['REMINDER_CAPACITY','INBOX_CAPACITY'].includes(error.code) ? 429 : 503;
}
function mountReminderRoutes(app, { requireAuth, featureDevice, service }) {
  const route = (method, suffix, operation, input) => app[method](`/api/devices/:mac/${suffix}`, requireAuth, featureDevice, async (req, res) => {
    try {
      const value = input(req);
      const result = await service.call(req.params.mac, operation, value);
      res.status(operation === 'create' && !result.duplicate ? 201 : 200).json(result);
    } catch (error) {
      const status = statusFor(error);
      res.status(status).json({ error: status === 503 ? 'Reminder storage unavailable; check status before retrying' : error.message, code: error.code || 'INVALID_REMINDER' });
    }
  });
  const query = req => {
    if (Object.keys(req.query).some(key => !['status','limit','offset','reminder_id','from','days'].includes(key))) throw new TypeError('Unexpected query fields');
    return Object.fromEntries(Object.entries(req.query).map(([key,value]) => [key, ['limit','offset','days'].includes(key) ? Number(value) : value]));
  };
  const body = req => { object(req.body, ['title','text','schedule','request_key']); return req.body; };
  route('get', 'reminders', 'list', query);
  route('post', 'reminders', 'create', body);
  route('get', 'reminders/agenda', 'agenda', query);
  route('get', 'reminders/calendar', 'calendar', query);
  route('get', 'reminders/occurrences', 'history', query);
  route('get', 'reminders/occurrences/:id/trace', 'trace', req => { object(req.query, []); return { occurrence_id: req.params.id }; });
  route('get', 'inbox/:id/trace', 'trace', req => { object(req.query, []); return { notification_id: req.params.id }; });
  route('post', 'reminders/skip', 'skip', req => { object(req.body, ['id','due_at','occurrence_id']); return req.body; });
  route('get', 'reminders/:id', 'get', req => ({ ...query(req), id: req.params.id }));
  route('patch', 'reminders/:id', 'update', req => { object(req.body, ['title','text','schedule','status','revision']); return { ...req.body, id: req.params.id }; });
  route('delete', 'reminders/:id', 'cancel', req => { object(req.body, ['confirm']); if (req.body.confirm !== true) throw new TypeError('Confirm cancellation'); return { id: req.params.id }; });
  route('post', 'reminders/occurrences/:id/snooze', 'snooze', req => { object(req.body, ['seconds','request_key']); return { ...req.body, occurrence_id: req.params.id }; });
  route('post', 'reminders/occurrences/:id/complete', 'complete', req => { object(req.body, ['confirm']); if (req.body.confirm !== true) throw new TypeError('Confirm completion'); return { occurrence_id: req.params.id }; });
  route('get', 'reminder-settings', 'settings_get', req => { object(req.query, []); return {}; });
  route('put', 'reminder-settings', 'settings_update', req => req.body);
  route('get', 'screen-breaks', 'screen_get', req => { object(req.query, []); return {}; });
  route('put', 'screen-breaks', 'screen_update', req => req.body);
  route('post', 'screen-breaks/command', 'screen_command', req => req.body);
  route('get', 'screen-breaks/history', 'screen_history', query);
}
module.exports = { createReminderService, mountReminderRoutes };
