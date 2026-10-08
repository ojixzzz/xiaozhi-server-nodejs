'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceIdleTimer, validateVoiceIdleSeconds, parseVoiceIdleSeconds, resolveVoiceIdleSeconds, parseVoiceActivityThreshold } = require('../lib/voice-idle');

function fixture(options = {}) {
  let time = 0, nextId = 0, expired = 0;
  const jobs = new Map();
  const timer = new VoiceIdleTimer({ timeoutMs: 60000, onIdle: () => { expired++; }, now: () => time,
    setTimer: (fn, delay) => { const id = ++nextId; jobs.set(id, { fn, due: time + delay }); return id; },
    clearTimer: id => jobs.delete(id), ...options });
  function advance(ms) {
    const target = time + ms;
    while (true) {
      const next = [...jobs].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > target) break;
      jobs.delete(next[0]); time = next[1].due; next[1].fn();
    }
    time = target;
  }
  return { timer, advance, jobs, get expired() { return expired; } };
}
function pcm(amplitude, dc = 0) {
  const buffer = Buffer.alloc(1920);
  for (let i = 0; i < 960; i++) buffer.writeInt16LE(dc + (i % 2 ? amplitude : -amplitude), i * 2);
  return buffer;
}

test('continuous silent/low-energy PCM and DC microphone bias do not keep a conversation open', () => {
  const f = fixture(); f.timer.start();
  for (let i = 0; i < 1000; i++) {
    assert.equal(f.timer.pcm(pcm(i % 2 ? 200 : 0, 1200)), false);
    f.advance(60);
  }
  assert.equal(f.expired, 1);
  assert.equal(f.jobs.size, 0);
});

test('sustained voice resets the idle window, but a click or separated loud frames do not', () => {
  const f = fixture(); f.timer.start(); f.advance(59000);
  assert.equal(f.timer.pcm(pcm(2000)), false);
  f.advance(60);
  assert.equal(f.timer.pcm(pcm(2000)), true);
  f.advance(59999);
  assert.equal(f.expired, 0);
  f.advance(1);
  assert.equal(f.expired, 1);

  const clicks = fixture(); clicks.timer.start(); clicks.advance(59000);
  clicks.timer.pcm(pcm(2000)); clicks.advance(300); clicks.timer.pcm(pcm(2000));
  clicks.advance(700);
  assert.equal(clicks.expired, 1);
});

test('AI generation, playback and parallel tools pause standby until all work finishes', () => {
  const f = fixture(); f.timer.start(); f.advance(59000);
  f.timer.hold('response'); f.timer.hold('playback');
  f.timer.hold('tool:a'); f.timer.hold('tool:b'); f.advance(60000);
  assert.equal(f.expired, 0);
  f.timer.release('response'); f.timer.release('tool:a'); f.timer.release('tool:b');
  f.advance(10000); assert.equal(f.expired, 0);
  f.timer.release('playback'); f.advance(59999); assert.equal(f.expired, 0);
  f.advance(1); assert.equal(f.expired, 1);
});

test('ongoing output refreshes its pause, but a missing completion cannot block standby forever', () => {
  const f = fixture(); f.timer.start(); f.timer.hold('response'); f.advance(110000);
  f.timer.hold('response'); f.advance(119999); assert.equal(f.expired, 0);
  f.advance(1); // Stalled hold expires; user receives a full idle window.
  f.advance(59999); assert.equal(f.expired, 0);
  f.advance(1); assert.equal(f.expired, 1);
});

test('transcription counts as activity; interrupted/error response resumes a full listening window', () => {
  const f = fixture(); f.timer.start(); f.advance(59000); f.timer.activity();
  f.advance(59000); assert.equal(f.expired, 0);
  f.timer.hold('response'); f.timer.hold('tool:a'); f.advance(30000);
  f.timer.resume(); f.advance(60000); assert.equal(f.expired, 1);
});

test('disabled timers never expire, and teardown ignores late SDK events', () => {
  const off = fixture({ timeoutMs: 0 }); off.timer.start(); off.advance(3600000);
  assert.equal(off.expired, 0); assert.equal(off.jobs.size, 0);
  const f = fixture(); f.timer.start(); f.timer.hold('response'); f.timer.stop();
  f.timer.activity(); f.timer.hold('response'); f.timer.resume(); f.timer.start();
  f.advance(3600000); assert.equal(f.expired, 0); assert.equal(f.jobs.size, 0);
});

test('timeout settings reject invalid values and safely inherit defaults for old device files', () => {
  assert.equal(parseVoiceIdleSeconds(undefined), 60);
  assert.equal(parseVoiceIdleSeconds('0'), 0);
  assert.equal(validateVoiceIdleSeconds(3600), 3600);
  assert.equal(resolveVoiceIdleSeconds(undefined, 120), 120);
  assert.equal(resolveVoiceIdleSeconds(null, 120), 120);
  assert.equal(resolveVoiceIdleSeconds('invalid', 120), 120);
  assert.equal(resolveVoiceIdleSeconds(0, 120), 0);
  for (const value of [-1, 1, 14, 3601, 60.5, '60', false]) assert.throws(() => validateVoiceIdleSeconds(value));
  for (const value of ['false', '-1', '1', '60.5', '3601']) assert.throws(() => parseVoiceIdleSeconds(value));
  assert.equal(parseVoiceActivityThreshold(undefined), 500);
  assert.equal(parseVoiceActivityThreshold('250'), 250);
  for (const value of ['0', '49', '10001', 'NaN']) assert.throws(() => parseVoiceActivityThreshold(value));
});
