'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAudioInputDiagnostics } = require('../lib/audio-input-diagnostics');
function fixture() {
  let now=0,callback,cleared=0; const events=[];
  const diagnostics=createAudioInputDiagnostics({now:()=>now,trace:{event:(event,fields,level)=>events.push({event,fields,level})},
    setTimer:(fn,ms)=>{assert.equal(ms,5000);callback=fn;return 1;},clearTimer:()=>{cleared++;}});
  return {diagnostics,events,get cleared(){return cleared;},tick(){now+=5000;callback();}};
}
test('many gaps produce debug details and just one warning summary per five seconds',()=>{
  const f=fixture();for(let i=0;i<100;i++)f.diagnostics.gap(10,60,5);
  assert.equal(f.events.filter(e=>e.level==='warn').length,0);
  f.diagnostics.transport({received:50,missing:1000,late:20,wait_ms:360,unrecovered:980});f.tick();
  const summary=f.events.filter(e=>e.level==='warn');assert.equal(summary.length,1);
  assert.equal(summary[0].fields.gaps,100);assert.equal(summary[0].fields.missing_frames,1000);
  assert.equal(summary[0].fields.missing_audio_ms,60000);assert.equal(summary[0].fields.concealed_audio_ms,30000);
  assert.equal(summary[0].fields.udp_delta.late,20);assert.equal(summary[0].fields.udp.wait_ms,360);
  f.tick();assert.equal(f.events.filter(e=>e.event==='audio.input_summary').length,1);
  f.diagnostics.stop();assert.equal(f.cleared,1);
});
test('stats use deltas, distinguish late recovery and flush the final incomplete window once',()=>{
  const f=fixture();f.diagnostics.transport({received:10,missing:2,late:0});f.tick();
  f.diagnostics.transport({received:12,missing:2,late:2,unrecovered:0});f.tick();
  const latest=f.events.at(-1);assert.equal(latest.level,'info');assert.equal(latest.fields.udp_delta.received,2);
  assert.equal(latest.fields.udp_delta.missing,0);assert.equal(latest.fields.udp_delta.late,2);
  f.diagnostics.gap(1,20,1);f.diagnostics.stop();f.diagnostics.stop();
  assert.equal(f.events.at(-1).fields.reason,'session_closed');assert.equal(f.events.at(-1).fields.missing_audio_ms,20);
  const count=f.events.length;f.diagnostics.gap(1,60,1);f.diagnostics.transport({received:999});assert.equal(f.events.length,count);
  assert.equal(f.cleared,1);
});
test('rejected UDP is visible even when no packet reaches the jitter buffer, without repeated warnings',()=>{
  const f=fixture();
  f.diagnostics.transport({received:0,forwarded:0,ingress_datagrams:12,rejected_source_ip:12});f.tick();
  assert.equal(f.events.length,1);assert.equal(f.events[0].level,'warn');
  assert.equal(f.events[0].fields.udp_delta.rejected_source_ip,12);
  f.tick();assert.equal(f.events.length,1);
  f.diagnostics.transport({received:1,forwarded:1,ingress_datagrams:13,rejected_source_ip:12});f.tick();
  assert.equal(f.events.at(-1).level,'info');assert.equal(f.events.at(-1).fields.udp_delta.rejected_source_ip,0);
  f.diagnostics.stop();
});
