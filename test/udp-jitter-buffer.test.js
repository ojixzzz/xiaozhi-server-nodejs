'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UdpJitterBuffer } = require('../lib/udp-jitter-buffer');

function fixture(options = {}) {
  let time = 0, id = 0;
  const timers = new Map(), output = [], gaps = [];
  const jitter = new UdpJitterBuffer({ ...options, now: () => time,
    onPacket: (data, sequence) => output.push(sequence), onGap: count => gaps.push(count),
    setTimer: (fn, ms) => { const key = ++id; timers.set(key, { fn, at: time + ms }); return key; },
    clearTimer: key => timers.delete(key) });
  return { jitter, output, gaps, timers, get now() { return time; },
    push: seq => jitter.push(seq, Buffer.alloc(1)),
    advance(ms) {
      const end = time + ms;
      while (true) {
        const next = [...timers.entries()].filter(([,timer]) => timer.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      time = end;
    }
  };
}
test('contiguous audio is immediate and reordered, duplicate and late packets are distinct', () => {
  const f = fixture(); f.push(1); assert.deepEqual(f.output, [1]);
  f.push(3); f.push(3); assert.deepEqual(f.output, [1]);
  f.advance(50); f.push(2); f.push(1);
  assert.deepEqual(f.output, [1,2,3]); assert.deepEqual(f.gaps, []);
  assert.equal(f.jitter.snapshot().duplicates, 2); assert.equal(f.jitter.snapshot().late, 0);
  assert.equal(f.jitter.snapshot().recovered, 1); assert.equal(f.jitter.snapshot().max_reorder_wait_ms, 50);
  f.jitter.stop(); assert.equal(f.timers.size, 0);
});
test('a deadline gap raises the window, counts its eventual arrival once and never replays it', () => {
  const f = fixture(); f.push(1); f.push(3);
  f.advance(119); assert.deepEqual(f.output, [1]);
  f.advance(1); assert.deepEqual(f.output, [1,3]); assert.deepEqual(f.gaps, [1]);
  assert.equal(f.jitter.waitMs, 240); assert.equal(f.jitter.snapshot().unrecovered, 1);
  assert.equal(f.push(2), false); assert.equal(f.push(2), false);
  assert.equal(f.jitter.snapshot().late, 1); assert.equal(f.jitter.snapshot().duplicates, 1);
  assert.equal(f.jitter.snapshot().unrecovered, 0); assert.equal(f.jitter.waitMs, 240);
  f.jitter.stop();
});
test('adaptation rescues audio arriving after the old 120 ms limit and recovers after stable traffic', () => {
  const f = fixture(); f.push(1); f.push(3); f.advance(120); f.advance(1000);
  f.push(5); f.advance(180); f.push(4);
  assert.deepEqual(f.output, [1,3,4,5]); assert.deepEqual(f.gaps, [1]); assert.equal(f.jitter.waitMs, 360);
  for (let i=0;i<100;i++) { f.advance(100); f.push(f.jitter.next); }
  assert.equal(f.jitter.waitMs, 240);
  for (let i=0;i<100;i++) { f.advance(100); f.push(f.jitter.next); }
  assert.equal(f.jitter.waitMs, 120); f.jitter.stop();
});
test('repeated gaps are bounded at 360 ms and large sequence jumps use bounded history', () => {
  const f = fixture();
  for (let i=0;i<200;i++) { f.push(f.jitter.next+1000); f.advance(f.jitter.waitMs); f.advance(1000); }
  assert.equal(f.jitter.waitMs, 360); assert.ok(f.jitter.missingRanges.length <= 128);
  assert.ok(f.jitter.seen.size <= 512); assert.ok(f.jitter.snapshot().untracked_missing > 0);
  assert.equal(f.jitter.snapshot().missing, 200000);
  f.push(1); assert.equal(f.jitter.snapshot().stale, 1);
  assert.equal(f.jitter.snapshot().late, 0); f.jitter.stop();
});
test('capacity flushing includes an incoming earlier packet and closing the hole never discards it', () => {
  const f = fixture({maxPackets:2}); f.push(4);f.push(5);f.push(2);
  assert.deepEqual(f.output,[2,4,5]);assert.deepEqual(f.gaps,[1,1]);assert.equal(f.jitter.pending.size,0);
  const other=fixture({maxPackets:2});other.push(2);other.push(3);other.push(1);
  assert.deepEqual(other.output,[1,2,3]);assert.deepEqual(other.gaps,[]);
  f.jitter.stop();other.jitter.stop();
});
test('listen-stop follows adaptation, drains trailing audio before ending and repeated stops cannot extend it', () => {
  const f=fixture();const ended=[];
  f.push(1);f.push(3);f.advance(10);f.jitter.requestEnd(()=>ended.push({at:f.now,output:[...f.output]}));
  f.advance(110);assert.equal(f.jitter.waitMs,240); // Gap timeout extended the stop deadline.
  f.advance(80);f.push(4);f.jitter.requestEnd(()=>assert.fail('duplicate stop callback'));
  f.advance(49);assert.deepEqual(ended,[]);
  f.advance(1);assert.deepEqual(ended,[{at:250,output:[1,3,4]}]);assert.equal(f.timers.size,0);
  f.jitter.stop();
});
test('a new listen cancels pending stop; teardown cancels both reorder and stop timers', () => {
  const f=fixture();let ended=0;
  f.jitter.requestEnd(()=>ended++);f.advance(50);f.jitter.cancelEnd();f.advance(400);assert.equal(ended,0);
  f.push(3);f.jitter.requestEnd(()=>ended++);f.jitter.stop();f.advance(1000);
  assert.equal(ended,0);assert.deepEqual(f.output,[]);assert.equal(f.timers.size,0);
});
test('listen-stop is bounded even with an unresolved hole and has no trailing replay', () => {
  const f=fixture();f.push(2);f.advance(120);f.advance(1000);f.push(4);f.advance(240);
  assert.equal(f.jitter.waitMs,360);
  const at=f.now;let endedAt;
  f.jitter.requestEnd(()=>{endedAt=f.now;});f.advance(300);f.push(6);f.advance(60);
  assert.equal(endedAt,at+360);assert.equal(f.output.at(-1),6);assert.deepEqual(f.gaps,[1,1,1]);
  assert.equal(f.push(5),false);f.jitter.stop();
});
